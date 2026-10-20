import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OrderConfirmationEmails } from '../src/email-outbox/order-confirmation-emails';
import { OrderConfirmationSettings } from '../src/orders/storefront/order-confirmation.settings';
import { checkStorefrontToken } from '../src/storefront-tokens/storefront-tokens';
import {
  createProduct,
  createTestApp,
  resetDatabase,
  tokenFrom,
  waitForMail,
  type TestContext,
} from './helpers';

jest.setTimeout(60_000);

const ADDRESS = {
  recipientName: 'Ayesha Khan',
  phone: '0300 1234567',
  addressLine1: 'House 12, Street 4, F-7/2',
  addressLine2: null,
  city: 'Islamabad',
  region: 'Islamabad Capital Territory',
  postalCode: '44000',
  country: 'PK',
};
// Typed as a shopper might; the order records it trimmed and lower-cased.
const CONTACT = {
  name: 'Ayesha Khan',
  email: '  Ayesha@Example.com ',
  phone: '0300 1234567',
};
const EMAIL = 'ayesha@example.com';
const HOUR_MS = 60 * 60 * 1000;

interface ConfirmationRequired {
  outcome: 'CONFIRMATION_REQUIRED';
  confirmation: {
    status: string;
    email: string;
    expiresAt: string;
    receiptToken: string | null;
  };
  order: { total: number; currency: string; items: unknown[] };
}

const transient = () =>
  Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' });

/** Polls until `ok` holds for what `read` returns (sends happen after commit). */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`condition not met: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * POST /storefront/orders with email confirmation switched off (today's
 * behaviour) and on (the order waits for its buyer). Two instances of the app
 * share the database; only their OrderConfirmationSettings differ.
 */
describe('Storefront order placement with email confirmation (e2e)', () => {
  let off: TestContext;
  let on: TestContext;

  beforeAll(async () => {
    off = await createTestApp();
    on = await createTestApp((builder) =>
      builder.overrideProvider(OrderConfirmationSettings).useValue({
        enabled: true,
        ttlMs: HOUR_MS,
        accountsEnabled: false,
        accountSetupTtlMs: 15 * 60_000,
      } satisfies OrderConfirmationSettings),
    );
  });

  afterAll(async () => {
    await on.close();
    await off.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(off.prisma);
    off.mail.clear();
    on.mail.clear();
  });

  const db = () => off.prisma;

  const listed = (stock = 10) =>
    createProduct(db(), { currency: 'PKR', price: '1500.00', stock });

  const orderFor = async (
    app: TestContext,
    items: { productId: string; quantity: number }[],
  ) => {
    const res = await request(app.app.getHttpServer())
      .post('/storefront/checkout/quote')
      .send({ items, shippingAddress: ADDRESS })
      .expect(200);
    return {
      contact: CONTACT,
      items,
      shippingAddress: ADDRESS,
      quoteToken: (res.body as { quoteToken: string }).quoteToken,
    };
  };

  const place = (app: TestContext, key: string, body: object) =>
    request(app.app.getHttpServer())
      .post('/storefront/orders')
      .set('Idempotency-Key', key)
      .send(body);

  const stockOf = async (product: { id: string }) =>
    (await db().product.findUniqueOrThrow({ where: { id: product.id } })).stock;

  const tokenCounts = async () => ({
    confirmation: await db().storefrontToken.count({
      where: { purpose: 'ORDER_CONFIRMATION' },
    }),
    receipt: await db().storefrontToken.count({
      where: { purpose: 'CHECKOUT_RECEIPT' },
    }),
  });

  /** Waits for the after-commit send, so it never runs into the next test. */
  const allSent = () =>
    eventually(
      () => db().emailJob.findMany({ select: { status: true } }),
      (jobs) => jobs.every((job) => job.status === 'SENT'),
    );

  const nothingWasWritten = async () => {
    expect(await db().order.count()).toBe(0);
    expect(await db().customer.count()).toBe(0);
    expect(await db().orderItem.count()).toBe(0);
    expect(await db().orderEvent.count()).toBe(0);
    expect(await db().productEvent.count()).toBe(0);
    expect(await db().emailJob.count()).toBe(0);
    expect(await db().storefrontToken.count()).toBe(0);
  };

  describe('switched off', () => {
    it('places the order as today: a receipt, and no confirmation, email or token', async () => {
      const product = await listed();
      const body = await orderFor(off, [
        { productId: `PRD-${product.number}`, quantity: 2 },
      ]);

      const res = await place(off, randomUUID(), body).expect(201);
      expect(res.body).toMatchObject({
        id: expect.stringMatching(/^ORD-\d+$/),
      });
      expect(res.body).not.toHaveProperty('outcome');

      const order = await db().order.findFirstOrThrow();
      expect(order).toMatchObject({
        status: 'PENDING',
        confirmationStatus: 'EXEMPT',
        confirmationEmail: null,
        confirmationExpiresAt: null,
        confirmedAt: null,
      });
      expect(await stockOf(product)).toBe(8);
      expect(await db().emailJob.count()).toBe(0);
      expect(await db().storefrontToken.count()).toBe(0);
      expect(off.mail.attempted).toHaveLength(0);
    });
  });

  describe('switched on', () => {
    it('saves the order awaiting confirmation, reserves its stock, records its email and tokens, and says so', async () => {
      const product = await listed();
      const body = await orderFor(on, [
        { productId: `PRD-${product.number}`, quantity: 2 },
      ]);

      const before = Date.now();
      const res = await place(on, randomUUID(), body).expect(201);
      const after = Date.now();
      const answer = res.body as ConfirmationRequired;

      expect(answer).toMatchObject({
        outcome: 'CONFIRMATION_REQUIRED',
        confirmation: { status: 'AWAITING_CONFIRMATION', email: EMAIL },
        order: { currency: 'PKR', total: 3000 },
      });
      expect(answer).not.toHaveProperty('id');
      expect(JSON.stringify(answer)).not.toMatch(/ORD-|Islamabad|0300/);
      const expiresAt = new Date(answer.confirmation.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS);
      expect(expiresAt).toBeLessThanOrEqual(after + HOUR_MS);
      expect(answer.confirmation.receiptToken).toMatch(
        /^cr_[A-Za-z0-9_-]{43}$/,
      );

      const order = await db().order.findFirstOrThrow();
      expect(order).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
        confirmationStatus: 'AWAITING_CONFIRMATION',
        confirmationEmail: EMAIL,
        confirmedAt: null,
        storefrontAccountId: null,
      });
      expect(order.confirmationExpiresAt?.toISOString()).toBe(
        answer.confirmation.expiresAt,
      );
      // The reservation is the stock the order took, recorded as usual.
      expect(await stockOf(product)).toBe(8);
      expect(await db().productEvent.count()).toBe(1);
      expect(await tokenCounts()).toEqual({ confirmation: 1, receipt: 1 });

      // The email goes out after the commit, with a link that confirms this order.
      const [email] = await waitForMail(on.mail, EMAIL);
      await allSent();
      await expect(
        checkStorefrontToken(db(), tokenFrom(email), 'ORDER_CONFIRMATION'),
      ).resolves.toMatchObject({
        status: 'valid',
        record: { orderId: order.id },
      });

      // Each credential does one thing.
      const receipt = answer.confirmation.receiptToken;
      await expect(
        checkStorefrontToken(db(), receipt, 'CHECKOUT_RECEIPT'),
      ).resolves.toMatchObject({
        status: 'valid',
        record: { orderId: order.id },
      });
      await expect(
        checkStorefrontToken(db(), receipt, 'ORDER_CONFIRMATION'),
      ).resolves.toEqual({ status: 'invalid' });
      await expect(
        checkStorefrontToken(db(), tokenFrom(email), 'CHECKOUT_RECEIPT'),
      ).resolves.toEqual({ status: 'invalid' });
    });

    it('does not wait for the mail server, and keeps the order when sending fails', async () => {
      const product = await listed();
      on.mail.delayMs = 3000;
      on.mail.failNext(transient());

      const started = Date.now();
      await place(
        on,
        randomUUID(),
        await orderFor(on, [
          { productId: `PRD-${product.number}`, quantity: 1 },
        ]),
      ).expect(201);
      expect(Date.now() - started).toBeLessThan(2500);

      const job = await eventually(
        () => db().emailJob.findFirstOrThrow(),
        (row) => row.attempts === 1 && row.attemptToken === null,
      );
      expect(job).toMatchObject({
        status: 'PENDING',
        failureCode: 'ECONNRESET',
      });
      expect(job.protectedPayload).not.toBeNull();
      expect(await db().order.count()).toBe(1);
      expect(await stockOf(product)).toBe(9);
    });

    it('rolls everything back, stock included, when the email cannot be recorded', async () => {
      const product = await listed();
      jest
        .spyOn(on.app.get(OrderConfirmationEmails), 'enqueue')
        .mockRejectedValueOnce(new Error('outbox unavailable'));

      await place(
        on,
        randomUUID(),
        await orderFor(on, [
          { productId: `PRD-${product.number}`, quantity: 3 },
        ]),
      ).expect(500);

      await nothingWasWritten();
      expect(await stockOf(product)).toBe(10);
      expect(on.mail.attempted).toHaveLength(0);
    });

    it('refuses an order there is not enough stock for, reserving and recording nothing', async () => {
      const product = await listed();
      const body = await orderFor(on, [
        { productId: `PRD-${product.number}`, quantity: 3 },
      ]);
      await db().product.update({
        where: { id: product.id },
        data: { stock: 2 },
      });

      const res = await place(on, randomUUID(), body).expect(409);
      expect(res.body).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      await nothingWasWritten();
      expect(await stockOf(product)).toBe(2);
    });

    it('answers a retried submission with the same order, reservation and email', async () => {
      const product = await listed();
      const key = randomUUID();
      const body = await orderFor(on, [
        { productId: `PRD-${product.number}`, quantity: 2 },
      ]);

      const first = (await place(on, key, body).expect(201))
        .body as ConfirmationRequired;
      const retry = (await place(on, key, body).expect(201))
        .body as ConfirmationRequired;

      expect(retry.confirmation.expiresAt).toBe(first.confirmation.expiresAt);
      expect(retry.order).toEqual(first.order);
      // Only hashes are kept, so the retry gets a receipt of its own; both work.
      expect(retry.confirmation.receiptToken).not.toBe(
        first.confirmation.receiptToken,
      );
      for (const token of [
        first.confirmation.receiptToken,
        retry.confirmation.receiptToken,
      ]) {
        await expect(
          checkStorefrontToken(db(), token, 'CHECKOUT_RECEIPT'),
        ).resolves.toMatchObject({ status: 'valid' });
      }

      expect(await db().order.count()).toBe(1);
      expect(await stockOf(product)).toBe(8);
      expect(await db().emailJob.count()).toBe(1);
      expect(await tokenCounts()).toEqual({ confirmation: 1, receipt: 2 });
      await allSent();
      expect(on.mail.sent).toHaveLength(1);
    });

    it('lets only one of two simultaneous submissions place the order', async () => {
      const product = await listed();
      const key = randomUUID();
      const body = await orderFor(on, [
        { productId: `PRD-${product.number}`, quantity: 2 },
      ]);

      const responses = await Promise.all([
        place(on, key, body),
        place(on, key, body),
      ]);
      expect(responses.map((res) => res.status)).toEqual([201, 201]);
      expect(await db().order.count()).toBe(1);
      expect(await stockOf(product)).toBe(8);
      expect(await db().emailJob.count()).toBe(1);
      await allSent();
      expect(on.mail.sent).toHaveLength(1);
    });

    it('refuses the same key for a different order', async () => {
      const product = await listed();
      const key = randomUUID();
      await place(
        on,
        key,
        await orderFor(on, [
          { productId: `PRD-${product.number}`, quantity: 1 },
        ]),
      ).expect(201);

      const res = await place(
        on,
        key,
        await orderFor(on, [
          { productId: `PRD-${product.number}`, quantity: 2 },
        ]),
      ).expect(409);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await db().order.count()).toBe(1);
      expect(await stockOf(product)).toBe(9);
      await allSent();
    });

    it('does not give the order to a storefront account with the same address', async () => {
      await db().storefrontAccount.create({
        data: {
          email: EMAIL,
          passwordHash: 'argon2-hash',
          emailVerifiedAt: new Date(),
        },
      });
      const product = await listed();
      await place(
        on,
        randomUUID(),
        await orderFor(on, [
          { productId: `PRD-${product.number}`, quantity: 1 },
        ]),
      ).expect(201);

      const order = await db().order.findFirstOrThrow();
      expect(order.storefrontAccountId).toBeNull();
      await allSent();
    });

    it('reports an order past its deadline as expired when it is asked about again', async () => {
      const product = await listed();
      const key = randomUUID();
      const body = await orderFor(on, [
        { productId: `PRD-${product.number}`, quantity: 1 },
      ]);
      await place(on, key, body).expect(201);
      await allSent();
      await db().order.updateMany({
        data: { confirmationExpiresAt: new Date(Date.now() - 1000) },
      });

      const replay = (await place(on, key, body).expect(201))
        .body as ConfirmationRequired;
      expect(replay.confirmation.status).toBe('EXPIRED');
      // Still within the receipt's day of grace.
      expect(replay.confirmation.receiptToken).toMatch(/^cr_/);
    });
  });

  describe('switching between the two', () => {
    it('answers each order as what it is, whatever the switch says now', async () => {
      const product = await listed();
      const items = [{ productId: `PRD-${product.number}`, quantity: 1 }];

      const legacyKey = randomUUID();
      const legacyBody = await orderFor(off, items);
      const placed = (await place(off, legacyKey, legacyBody).expect(201))
        .body as { id: string };
      const replayedOn = await place(on, legacyKey, legacyBody).expect(201);
      expect(replayedOn.body).toMatchObject({ id: placed.id });
      expect(replayedOn.body).not.toHaveProperty('outcome');
      expect(await db().storefrontToken.count()).toBe(0);
      expect(await db().emailJob.count()).toBe(0);

      const awaitingKey = randomUUID();
      const awaitingBody = await orderFor(on, items);
      await place(on, awaitingKey, awaitingBody).expect(201);
      await allSent();
      const replayedOff = await place(off, awaitingKey, awaitingBody).expect(
        201,
      );
      expect(replayedOff.body).toMatchObject({
        outcome: 'CONFIRMATION_REQUIRED',
        confirmation: { status: 'AWAITING_CONFIRMATION' },
      });

      expect(await db().order.count()).toBe(2);
      expect(await stockOf(product)).toBe(8);
      expect(await db().emailJob.count()).toBe(1);
    });
  });
});
