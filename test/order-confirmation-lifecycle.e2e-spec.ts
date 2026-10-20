import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { OrderExpiryService } from '../src/orders/order-expiry.service';
import { OrderConfirmationSettings } from '../src/orders/storefront/order-confirmation.settings';
import { checkStorefrontToken } from '../src/storefront-tokens/storefront-tokens';
import {
  bearer,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  tokenFrom,
  waitForMail,
  type TestContext,
} from './helpers';

jest.setTimeout(60_000);

const HOUR_MS = 60 * 60 * 1000;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(25);
  }
}

/**
 * The confirmation lifecycle over HTTP: preview, confirm, the checkout receipt
 * (status, resend), expiry and the dashboard's refusals, with confirmation on.
 */
describe('Order confirmation lifecycle (e2e)', () => {
  let ctx: TestContext;
  let adminToken: string;
  let seq = 0;
  // Mutable on purpose: a test may switch accounts off, afterEach restores.
  const settings = {
    enabled: true,
    ttlMs: HOUR_MS,
    accountsEnabled: true,
    accountSetupTtlMs: 15 * 60_000,
  };

  beforeAll(async () => {
    ctx = await createTestApp((builder) =>
      builder.overrideProvider(OrderConfirmationSettings).useValue(settings),
    );
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    // No after-commit send of the previous test may still be running.
    await eventually(
      () =>
        ctx.prisma.emailJob.count({ where: { attemptToken: { not: null } } }),
      (leased) => leased === 0,
    );
    await resetDatabase(ctx.prisma);
    ctx.mail.clear();
    await createUser(ctx.prisma, { email: 'admin@example.com', role: 'ADMIN' });
    adminToken = (await login(ctx.app, 'admin@example.com')).accessToken;
  });

  afterEach(() => {
    settings.accountsEnabled = true;
  });

  const http = () => request(ctx.app.getHttpServer());
  const db = () => ctx.prisma;
  const expiry = () => ctx.app.get(OrderExpiryService);

  const preview = (token: unknown) =>
    http().post('/storefront/order-confirmations/preview').send({ token });
  const confirm = (token: unknown) =>
    http().post('/storefront/order-confirmations/confirm').send({ token });
  const receiptStatus = (receiptToken: unknown) =>
    http().post('/storefront/checkout-receipts/status').send({ receiptToken });
  const resend = (receiptToken: unknown) =>
    http()
      .post('/storefront/checkout-receipts/resend-confirmation')
      .send({ receiptToken });

  const listed = (stock = 10) =>
    createProduct(db(), { currency: 'PKR', price: '1500.00', stock });

  const stockOf = async (product: { id: string }) =>
    (await db().product.findUniqueOrThrow({ where: { id: product.id } })).stock;

  /**
   * Places an order awaiting confirmation and waits for its email. Returns
   * what the shopper holds: the receipt token and the link token.
   */
  const placeAwaiting = async (
    product: { number: number },
    options: { quantity?: number; email?: string } = {},
  ) => {
    seq += 1;
    const email = options.email ?? `shopper${seq}@example.com`;
    const items = [
      { productId: `PRD-${product.number}`, quantity: options.quantity ?? 2 },
    ];
    const quote = await http()
      .post('/storefront/checkout/quote')
      .send({ items, shippingAddress: ADDRESS })
      .expect(200);
    const placed = await http()
      .post('/storefront/orders')
      .set('Idempotency-Key', randomUUID())
      .send({
        contact: { name: 'Ayesha Khan', email, phone: '0300 1234567' },
        items,
        shippingAddress: ADDRESS,
        quoteToken: (quote.body as { quoteToken: string }).quoteToken,
      })
      .expect(201);
    const body = placed.body as {
      confirmation: { receiptToken: string; expiresAt: string };
    };
    const before = ctx.mail.to(email).length;
    const emails = await waitForMail(ctx.mail, email, before + 1);
    const order = await db().order.findFirstOrThrow({
      where: { confirmationEmail: email },
      orderBy: { createdAt: 'desc' },
    });
    return {
      email,
      order,
      receiptToken: body.confirmation.receiptToken,
      expiresAt: body.confirmation.expiresAt,
      link: tokenFrom(emails[emails.length - 1]),
    };
  };

  const moveDeadline = (orderId: string, msFromNow: number) =>
    db().order.update({
      where: { id: orderId },
      data: { confirmationExpiresAt: new Date(Date.now() + msFromNow) },
    });

  /** Lets the resend cooldown pass, as if the last email were a minute old. */
  const ageEmails = (orderId: string) =>
    db().emailJob.updateMany({
      where: { orderId },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });

  const cancellationsOf = async (orderNumber: number) => ({
    stockEvents: (
      await db().productEvent.findMany({ select: { data: true } })
    ).filter(
      ({ data }) =>
        (data as { reason?: string; orderNumber?: number }).reason ===
          'ORDER_CANCELLED' &&
        (data as { orderNumber?: number }).orderNumber === orderNumber,
    ).length,
    statusEvents: await db().orderEvent.count({
      where: {
        order: { number: orderNumber },
        type: 'STATUS_CHANGED',
        toStatus: 'CANCELLED',
      },
    }),
  });

  describe('features', () => {
    it('says what is switched on', async () => {
      await http()
        .get('/storefront/features')
        .expect(200, { orderConfirmation: true, storefrontAccounts: true });
    });
  });

  describe('preview', () => {
    it('shows what is being confirmed without using the link or touching the order', async () => {
      const product = await listed();
      const { link, order, expiresAt } = await placeAwaiting(product);

      for (let i = 0; i < 2; i++) {
        const res = await preview(link).expect(200);
        expect(res.body).toEqual({
          status: 'AWAITING_CONFIRMATION',
          expiresAt,
          order: expect.objectContaining({ total: 3000, currency: 'PKR' }),
          delivery: {
            recipientName: 'Ayesha Khan',
            city: 'Islamabad',
            region: 'Islamabad Capital Territory',
            country: 'PK',
          },
        });
        expect(JSON.stringify(res.body)).not.toMatch(/ORD-|House 12|0300|@/);
      }
      // A GET with the token (a link opened, a mail scanner) reaches nothing.
      await http()
        .get(`/storefront/order-confirmations/preview?token=${link}`)
        .expect(404);
      await http()
        .get(`/storefront/order-confirmations/confirm?token=${link}`)
        .expect(404);

      await expect(
        checkStorefrontToken(db(), link, 'ORDER_CONFIRMATION'),
      ).resolves.toMatchObject({ status: 'valid' });
      await expect(
        db().order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({
        confirmationStatus: 'AWAITING_CONFIRMATION',
        confirmedAt: null,
      });
      await confirm(link).expect(200);
    });

    it('refuses anything but a confirmation link alike', async () => {
      const product = await listed();
      const { receiptToken } = await placeAwaiting(product);
      for (const token of [receiptToken, 'oc_nope', `oc_${'a'.repeat(43)}`]) {
        const res = await preview(token).expect(404);
        expect(res.body).toMatchObject({ code: 'CONFIRMATION_NOT_FOUND' });
        await confirm(token).expect(404);
      }
      await preview(undefined).expect(400);
    });

    it('reports an order past its deadline as expired, without expiring it', async () => {
      const product = await listed();
      const { link, order } = await placeAwaiting(product);
      await moveDeadline(order.id, -1000);

      await preview(link).expect(200, { status: 'EXPIRED' });
      await expect(
        db().order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ confirmationStatus: 'AWAITING_CONFIRMATION' });
      expect(await stockOf(product)).toBe(8);
    });
  });

  describe('confirming', () => {
    it('confirms once, keeping the reserved stock, and offers a separate setup grant', async () => {
      const product = await listed();
      const { link, order, email } = await placeAwaiting(product);
      expect(await stockOf(product)).toBe(8);

      const before = Date.now();
      const res = await confirm(link).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'CONFIRMED',
        alreadyConfirmed: false,
        order: { id: `ORD-${order.number}`, status: 'PENDING', total: 3000 },
        delivery: {
          contactName: 'Ayesha Khan',
          email,
          address: { city: 'Islamabad' },
        },
        account: {
          kind: 'SETUP_AVAILABLE',
          setupToken: expect.stringMatching(/^as_[A-Za-z0-9_-]{43}$/),
        },
      });
      const account = (
        res.body as { account: { setupToken: string; expiresAt: string } }
      ).account;
      const grantExpires = new Date(account.expiresAt).getTime();
      expect(grantExpires).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
      expect(grantExpires).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
      await expect(
        checkStorefrontToken(db(), account.setupToken, 'ACCOUNT_SETUP'),
      ).resolves.toMatchObject({
        status: 'valid',
        record: { orderId: order.id, email },
      });
      // The grant confirms nothing, and the link sets up nothing.
      await confirm(account.setupToken).expect(404);
      await expect(
        checkStorefrontToken(db(), link, 'ACCOUNT_SETUP'),
      ).resolves.toEqual({ status: 'invalid' });

      const confirmed = await db().order.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(confirmed).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        confirmationStatus: 'CONFIRMED',
        storefrontAccountId: null,
      });
      expect(confirmed.confirmedAt).toBeInstanceOf(Date);
      // Taken once, when the order was placed.
      expect(await stockOf(product)).toBe(8);
      expect(await db().productEvent.count()).toBe(1);
      await expect(
        checkStorefrontToken(db(), link, 'ORDER_CONFIRMATION'),
      ).resolves.toMatchObject({ status: 'used' });
    });

    it('answers a repeated confirmation safely, without minting a new setup grant', async () => {
      const product = await listed();
      const { link, order } = await placeAwaiting(product);
      await confirm(link).expect(200);

      const again = await confirm(link).expect(200);
      expect(again.body).toMatchObject({
        outcome: 'CONFIRMED',
        alreadyConfirmed: true,
        order: { id: `ORD-${order.number}` },
        account: { kind: 'NONE' },
      });
      expect(
        await db().storefrontToken.count({
          where: { purpose: 'ACCOUNT_SETUP' },
        }),
      ).toBe(1);
      expect(await stockOf(product)).toBe(8);
      await preview(link).expect(200, { status: 'CONFIRMED' });
    });

    it('lets one of many simultaneous clicks confirm, and the rest find it confirmed', async () => {
      const product = await listed();
      const { link } = await placeAwaiting(product);

      const responses = await Promise.all(
        Array.from({ length: 4 }, () => confirm(link)),
      );
      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      const fresh = responses.filter(
        (res) =>
          (res.body as { alreadyConfirmed: boolean }).alreadyConfirmed ===
          false,
      );
      expect(fresh).toHaveLength(1);
      expect(
        await db().storefrontToken.count({
          where: { purpose: 'ACCOUNT_SETUP' },
        }),
      ).toBe(1);
      expect(await stockOf(product)).toBe(8);
    });

    it('gives the order to the account that has the proven address, and offers sign-in', async () => {
      const product = await listed();
      const email = 'member@example.com';
      const account = await db().storefrontAccount.create({
        data: {
          email,
          passwordHash: 'argon2-hash',
          emailVerifiedAt: new Date(),
        },
      });
      const { link, order } = await placeAwaiting(product, { email });
      // Placing did not give it away.
      expect(order.storefrontAccountId).toBeNull();

      const res = await confirm(link).expect(200);
      expect(res.body).toMatchObject({ account: { kind: 'SIGN_IN' } });
      await expect(
        db().order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ storefrontAccountId: account.id });
      expect(
        await db().storefrontToken.count({
          where: { purpose: 'ACCOUNT_SETUP' },
        }),
      ).toBe(0);
    });

    it('offers nothing about accounts while they are switched off', async () => {
      settings.accountsEnabled = false;
      const product = await listed();
      const { link } = await placeAwaiting(product);
      const res = await confirm(link).expect(200);
      expect(res.body).toMatchObject({ account: { kind: 'NONE' } });
      expect(
        await db().storefrontToken.count({
          where: { purpose: 'ACCOUNT_SETUP' },
        }),
      ).toBe(0);
    });

    it('refuses after the deadline, expiring the order there and then and returning its stock', async () => {
      const product = await listed();
      const { link, order } = await placeAwaiting(product);
      await moveDeadline(order.id, -1000);

      const res = await confirm(link).expect(410);
      expect(res.body).toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
      await expect(
        db().order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        confirmationStatus: 'EXPIRED',
        confirmedAt: null,
      });
      expect(await stockOf(product)).toBe(10);
      await confirm(link).expect(410);
      expect(await stockOf(product)).toBe(10);
      expect(await cancellationsOf(order.number)).toEqual({
        stockEvents: 1,
        statusEvents: 1,
      });
    });
  });

  describe('the checkout receipt', () => {
    it('reads how the order stands, and nothing else', async () => {
      const product = await listed();
      const { receiptToken, link, email, expiresAt } =
        await placeAwaiting(product);

      const waiting = await receiptStatus(receiptToken).expect(200);
      expect(waiting.body).toEqual({
        status: 'AWAITING_CONFIRMATION',
        expiresAt,
        email,
        resend: { remaining: 3, availableAt: expect.any(String) },
      });

      await confirm(link).expect(200);
      await receiptStatus(receiptToken).expect(200, {
        status: 'CONFIRMED',
        expiresAt,
        email,
        resend: { remaining: 0, availableAt: null },
      });

      for (const token of [link, 'cr_nope', `cr_${'a'.repeat(43)}`]) {
        const res = await receiptStatus(token).expect(404);
        expect(res.body).toMatchObject({ code: 'RECEIPT_NOT_FOUND' });
        await resend(token).expect(404);
      }
    });

    it('sends a new link, retiring the old one, without moving the deadline', async () => {
      const product = await listed();
      const placed = await placeAwaiting(product);
      await ageEmails(placed.order.id);

      const res = await resend(placed.receiptToken).expect(202);
      expect(res.body).toMatchObject({
        status: 'AWAITING_CONFIRMATION',
        expiresAt: placed.expiresAt,
        resend: { remaining: 2 },
      });
      const emails = await waitForMail(ctx.mail, placed.email, 2);
      const newLink = tokenFrom(emails[1]);
      expect(newLink).not.toBe(placed.link);

      await preview(placed.link).expect(200, { status: 'LINK_REPLACED' });
      const stale = await confirm(placed.link).expect(410);
      expect(stale.body).toMatchObject({ code: 'CONFIRMATION_LINK_REPLACED' });

      await expect(
        db().order.findUniqueOrThrow({ where: { id: placed.order.id } }),
      ).resolves.toMatchObject({
        confirmationExpiresAt: new Date(placed.expiresAt),
      });
      await confirm(newLink).expect(200);
      expect(await stockOf(product)).toBe(8);
    });

    it('cancels a confirmation email still waiting to be sent when a new one is asked for', async () => {
      const product = await listed();
      ctx.mail.failNext(
        Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
      );
      seq += 1;
      const email = `stale${seq}@example.com`;
      // Placed by hand: its first email fails and waits for a retry.
      const items = [{ productId: `PRD-${product.number}`, quantity: 1 }];
      const quote = await http()
        .post('/storefront/checkout/quote')
        .send({ items, shippingAddress: ADDRESS })
        .expect(200);
      const placed = await http()
        .post('/storefront/orders')
        .set('Idempotency-Key', randomUUID())
        .send({
          contact: { name: 'Ayesha Khan', email, phone: '0300 1234567' },
          items,
          shippingAddress: ADDRESS,
          quoteToken: (quote.body as { quoteToken: string }).quoteToken,
        })
        .expect(201);
      const receiptToken = (
        placed.body as { confirmation: { receiptToken: string } }
      ).confirmation.receiptToken;
      const first = await eventually(
        () => db().emailJob.findFirstOrThrow(),
        (job) => job.attempts === 1 && job.attemptToken === null,
      );
      expect(first.status).toBe('PENDING');
      await ageEmails(first.orderId!);

      await resend(receiptToken).expect(202);
      await expect(
        db().emailJob.findUniqueOrThrow({ where: { id: first.id } }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        failureCode: 'SUPERSEDED',
        protectedPayload: null,
      });
      const [only] = await waitForMail(ctx.mail, email, 1);
      expect(ctx.mail.to(email)).toHaveLength(1);
      await confirm(tokenFrom(only)).expect(200);
    });

    it('is limited in rate and in number', async () => {
      const product = await listed();
      const placed = await placeAwaiting(product);

      const tooSoon = await resend(placed.receiptToken).expect(429);
      expect(tooSoon.body).toMatchObject({ code: 'RESEND_TOO_SOON' });
      const wait = (tooSoon.body as { retryAfterSeconds: number })
        .retryAfterSeconds;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60);

      for (let i = 1; i <= 3; i++) {
        await ageEmails(placed.order.id);
        const res = await resend(placed.receiptToken).expect(202);
        expect(res.body).toMatchObject({ resend: { remaining: 3 - i } });
      }
      await ageEmails(placed.order.id);
      const limit = await resend(placed.receiptToken).expect(429);
      expect(limit.body).toMatchObject({ code: 'RESEND_LIMIT_REACHED' });
      await receiptStatus(placed.receiptToken).expect(200);
      expect(
        await db().emailJob.count({ where: { orderId: placed.order.id } }),
      ).toBe(4);
      // Only the newest link is any use.
      expect(
        await db().storefrontToken.count({
          where: {
            orderId: placed.order.id,
            purpose: 'ORDER_CONFIRMATION',
            usedAt: null,
          },
        }),
      ).toBe(1);
    });

    it('refuses once the order is confirmed or past its deadline', async () => {
      const product = await listed();
      const confirmedOrder = await placeAwaiting(product);
      await confirm(confirmedOrder.link).expect(200);
      await ageEmails(confirmedOrder.order.id);
      const confirmed = await resend(confirmedOrder.receiptToken).expect(409);
      expect(confirmed.body).toMatchObject({
        code: 'CONFIRMATION_NOT_PENDING',
        status: 'CONFIRMED',
      });

      const late = await placeAwaiting(product);
      await moveDeadline(late.order.id, -1000);
      await ageEmails(late.order.id);
      const expired = await resend(late.receiptToken).expect(409);
      expect(expired.body).toMatchObject({
        code: 'CONFIRMATION_NOT_PENDING',
        status: 'EXPIRED',
      });
      // Asking expired it, and returned its stock.
      expect(await stockOf(product)).toBe(8);
      await receiptStatus(late.receiptToken).expect(200);
    });
  });

  describe('expiry', () => {
    it('expires only orders past their deadline, returning their stock', async () => {
      const product = await listed();
      const due = await placeAwaiting(product);
      const notYet = await placeAwaiting(product);
      expect(await stockOf(product)).toBe(6);
      await moveDeadline(due.order.id, -1);
      await moveDeadline(notYet.order.id, 5000);

      await expect(expiry().expireOverdue()).resolves.toBe(1);
      expect(await stockOf(product)).toBe(8);
      await expect(
        db().order.findUniqueOrThrow({ where: { id: due.order.id } }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        confirmationStatus: 'EXPIRED',
      });
      await expect(
        db().order.findUniqueOrThrow({ where: { id: notYet.order.id } }),
      ).resolves.toMatchObject({ confirmationStatus: 'AWAITING_CONFIRMATION' });
      await expect(
        checkStorefrontToken(db(), due.link, 'ORDER_CONFIRMATION'),
      ).resolves.toMatchObject({ status: 'used' });
      await receiptStatus(due.receiptToken).expect(200, {
        status: 'EXPIRED',
        expiresAt: (
          await db().order.findUniqueOrThrow({ where: { id: due.order.id } })
        ).confirmationExpiresAt!.toISOString(),
        email: due.email,
        resend: { remaining: 0, availableAt: null },
      });
      await confirm(notYet.link).expect(200);
    });

    it('returns the stock exactly once however many sweeps run', async () => {
      const product = await listed();
      const { order } = await placeAwaiting(product, { quantity: 3 });
      await moveDeadline(order.id, -1000);

      const counts = await Promise.all([
        expiry().expireOverdue(),
        expiry().expireOverdue(),
        expiry().expireOverdue(),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
      await expect(expiry().expireOverdue()).resolves.toBe(0);
      expect(await stockOf(product)).toBe(10);
      expect(await cancellationsOf(order.number)).toEqual({
        stockEvents: 1,
        statusEvents: 1,
      });
    });

    it('resolves a confirmation racing the expiry at the deadline to exactly one outcome', async () => {
      for (let round = 0; round < 4; round++) {
        const product = await listed();
        const { link, order } = await placeAwaiting(product);
        await moveDeadline(order.id, 300);
        await sleep(250 + round * 20);

        const [confirmed] = await Promise.all([
          confirm(link),
          expiry().expireOverdue(),
          expiry().expireOverdue(),
        ]);
        await sleep(100);
        await expiry().expireOverdue();

        const final = await db().order.findUniqueOrThrow({
          where: { id: order.id },
        });
        const released = await cancellationsOf(order.number);
        if (final.confirmationStatus === 'CONFIRMED') {
          expect(confirmed.status).toBe(200);
          expect(final.status).toBe('PENDING');
          expect(await stockOf(product)).toBe(8);
          expect(released).toEqual({ stockEvents: 0, statusEvents: 0 });
        } else {
          expect(final.confirmationStatus).toBe('EXPIRED');
          expect(confirmed.status).toBe(410);
          expect(final.status).toBe('CANCELLED');
          expect(await stockOf(product)).toBe(10);
          expect(released).toEqual({ stockEvents: 1, statusEvents: 1 });
        }
      }
    });

    it('releases stock held by expired orders before a quote or an order looks for it', async () => {
      const product = await listed(2);
      const { order } = await placeAwaiting(product, { quantity: 2 });
      expect(await stockOf(product)).toBe(0);
      await moveDeadline(order.id, -1000);

      // No sweep has run: the quote releases what it needs.
      await placeAwaiting(product, { quantity: 2 });
      expect(await stockOf(product)).toBe(0);
      await expect(
        db().order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ confirmationStatus: 'EXPIRED' });
    });
  });

  describe('placing', () => {
    it('limits how many orders one address may have waiting', async () => {
      const product = await listed();
      const email = 'busy@example.com';
      const first = await placeAwaiting(product, { quantity: 1, email });
      await placeAwaiting(product, { quantity: 1, email });
      await placeAwaiting(product, { quantity: 1, email });

      const items = [{ productId: `PRD-${product.number}`, quantity: 1 }];
      const quote = await http()
        .post('/storefront/checkout/quote')
        .send({ items, shippingAddress: ADDRESS })
        .expect(200);
      const body = {
        contact: { name: 'Ayesha Khan', email, phone: '0300 1234567' },
        items,
        shippingAddress: ADDRESS,
        quoteToken: (quote.body as { quoteToken: string }).quoteToken,
      };
      const refused = await http()
        .post('/storefront/orders')
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(429);
      expect(refused.body).toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' });
      expect(await stockOf(product)).toBe(7);

      // One that ran out no longer counts.
      await moveDeadline(first.order.id, -1000);
      await http()
        .post('/storefront/orders')
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(201);
    });
  });

  describe('the dashboard', () => {
    const patch = (orderNumber: number, path: string, body: object) =>
      http()
        .patch(`/orders/ORD-${orderNumber}/${path}`)
        .set(bearer(adminToken))
        .send(body);

    it('cannot fulfil, cancel or record payment for an order before its buyer confirms it', async () => {
      const product = await listed();
      const { link, order } = await placeAwaiting(product);

      for (const status of ['PROCESSING', 'SHIPPED', 'CANCELLED']) {
        const res = await patch(order.number, 'status', { status }).expect(409);
        expect((res.body as { message: string }).message).toMatch(
          /waiting for the customer to confirm it by email/,
        );
      }
      await patch(order.number, 'payment-status', {
        paymentStatus: 'PAID',
      }).expect(409);
      expect(await stockOf(product)).toBe(8);

      await confirm(link).expect(200);
      await patch(order.number, 'status', { status: 'PROCESSING' }).expect(200);
      await patch(order.number, 'status', { status: 'CANCELLED' }).expect(200);
      expect(await stockOf(product)).toBe(10);
      expect(await cancellationsOf(order.number)).toEqual({
        stockEvents: 1,
        statusEvents: 1,
      });
    });

    it('shows staff where an order stands on email confirmation', async () => {
      const product = await listed();
      const { link, order, expiresAt } = await placeAwaiting(product);
      const listed1 = await http()
        .get('/orders')
        .set(bearer(adminToken))
        .expect(200);
      const row = (
        listed1.body as {
          data: { id: string; emailConfirmation: unknown }[];
        }
      ).data.find((o) => o.id === `ORD-${order.number}`);
      expect(row?.emailConfirmation).toEqual({
        status: 'AWAITING_CONFIRMATION',
        expiresAt,
        confirmedAt: null,
      });

      await confirm(link).expect(200);
      const detail = await http()
        .get(`/orders/ORD-${order.number}`)
        .set(bearer(adminToken))
        .expect(200);
      expect(
        (detail.body as { emailConfirmation: unknown }).emailConfirmation,
      ).toEqual({
        status: 'CONFIRMED',
        expiresAt,
        confirmedAt: expect.any(String),
      });
    });

    it('treats an expired order as cancelled', async () => {
      const product = await listed();
      const { order } = await placeAwaiting(product);
      await moveDeadline(order.id, -1000);
      await expiry().expireOverdue();

      await patch(order.number, 'status', { status: 'PROCESSING' }).expect(409);
      await patch(order.number, 'payment-status', {
        paymentStatus: 'PAID',
      }).expect(409);
      expect(await stockOf(product)).toBe(10);
    });
  });
});
