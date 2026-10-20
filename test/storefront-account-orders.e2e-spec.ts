import request from 'supertest';
import { OrderConfirmationSettings } from '../src/orders/storefront/order-confirmation.settings';
import { issueStorefrontToken } from '../src/storefront-tokens/storefront-tokens';
import {
  bearer,
  createCustomer,
  createOrder,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(60_000);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PASSWORD = 'Shopper-Passw0rd';

const SUMMARY_KEYS = [
  'confirmedAt',
  'createdAt',
  'currency',
  'id',
  'itemCount',
  'paymentMethod',
  'paymentStatus',
  'status',
  'total',
];

interface Page {
  data: { id: string; createdAt: string }[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

/**
 * The signed-in shopper's order history, and which orders an account may own:
 * isolation between accounts, guessed ids, one verified address filed under
 * several customer records, and legacy or unconfirmed orders never attached.
 */
describe('Storefront account orders (e2e)', () => {
  let ctx: TestContext;
  let seq = 0;
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
    await resetDatabase(ctx.prisma);
  });

  afterEach(() => {
    settings.accountsEnabled = true;
  });

  const http = () => request(ctx.app.getHttpServer());
  const db = () => ctx.prisma;

  const nextEmail = () => {
    seq += 1;
    return `shopper${seq}@example.com`;
  };

  const customerFor = async (email: string, name?: string) =>
    (await db().customer.findUnique({ where: { email } })) ??
    createCustomer(db(), { email, name });

  /** An order confirmed through `email`'s inbox, filed under `customer`. */
  const confirmedOrder = async (
    email: string,
    options: {
      customer?: {
        id: string;
        name: string;
        email: string;
        phone: string | null;
      };
      createdAt?: Date;
      accountId?: string;
      recipientName?: string;
    } = {},
  ) => {
    const customer = options.customer ?? (await customerFor(email));
    const createdAt = options.createdAt ?? new Date();
    return createOrder(db(), customer, {
      status: 'PENDING',
      paymentStatus: 'PENDING',
      paymentMethod: 'COD',
      createdAt,
      shippingAddress: options.recipientName
        ? { recipientName: options.recipientName }
        : undefined,
      confirmation: {
        status: 'CONFIRMED',
        email,
        expiresAt: new Date(createdAt.getTime() + HOUR_MS),
        confirmedAt: new Date(createdAt.getTime() + 60_000),
        storefrontAccountId: options.accountId ?? null,
      },
    });
  };

  /**
   * An account for `email`, created the way a shopper creates one (a setup
   * grant bound to one of the address's confirmed orders), signed in.
   */
  const accountFor = async (email: string) => {
    const order =
      (await db().order.findFirst({
        where: { confirmationEmail: email, confirmationStatus: 'CONFIRMED' },
      })) ?? (await confirmedOrder(email));
    const grant = await issueStorefrontToken(db(), {
      purpose: 'ACCOUNT_SETUP',
      orderId: order.id,
      email,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const res = await http()
      .post('/storefront/account/setup')
      .send({
        setupToken: grant.token,
        password: PASSWORD,
        confirmPassword: PASSWORD,
      })
      .expect(201);
    const created = await db().storefrontAccount.findUniqueOrThrow({
      where: { email },
    });
    return {
      id: created.id,
      email,
      accessToken: (res.body as { accessToken: string }).accessToken,
    };
  };

  const list = (accessToken: string, query: Record<string, unknown> = {}) =>
    http()
      .get('/storefront/account/orders')
      .query(query)
      .set(bearer(accessToken));
  const detail = (accessToken: string, orderId: string) =>
    http()
      .get(`/storefront/account/orders/${encodeURIComponent(orderId)}`)
      .set(bearer(accessToken));

  const ownerOf = async (orderId: string) =>
    (await db().order.findUniqueOrThrow({ where: { id: orderId } }))
      .storefrontAccountId;

  describe('the history', () => {
    it('lists the account’s orders newest first, a page at a time, with summary fields only', async () => {
      const email = nextEmail();
      const base = Date.now() - 30 * DAY_MS;
      const placed = [];
      for (let i = 0; i < 12; i++) {
        // Two orders share a timestamp: the newer number comes first.
        const at = new Date(base + Math.min(i, 10) * DAY_MS);
        placed.push(await confirmedOrder(email, { createdAt: at }));
      }
      const shopper = await accountFor(email);
      const newestFirst = [...placed]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.number - a.number,
        )
        .map((o) => `ORD-${o.number}`);

      const first = await list(shopper.accessToken, { pageSize: 5 }).expect(
        200,
      );
      const page1 = first.body as Page;
      expect(page1.meta).toEqual({
        page: 1,
        pageSize: 5,
        total: 12,
        totalPages: 3,
      });
      expect(page1.data.map((o) => o.id)).toEqual(newestFirst.slice(0, 5));
      for (const row of page1.data) {
        expect(Object.keys(row).sort()).toEqual(SUMMARY_KEYS);
      }
      expect(page1.data[0]).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
        currency: 'PKR',
        itemCount: 1,
        total: 100,
      });

      const third = (
        await list(shopper.accessToken, { page: 3, pageSize: 5 }).expect(200)
      ).body as Page;
      expect(third.data.map((o) => o.id)).toEqual(newestFirst.slice(10));
      const beyond = (
        await list(shopper.accessToken, { page: 4, pageSize: 5 }).expect(200)
      ).body as Page;
      expect(beyond.data).toEqual([]);
      const defaults = (await list(shopper.accessToken).expect(200))
        .body as Page;
      expect(defaults.meta).toMatchObject({ page: 1, pageSize: 10 });

      for (const query of [
        { pageSize: 51 },
        { pageSize: 0 },
        { page: 0 },
        { page: 'x' },
      ]) {
        await list(shopper.accessToken, query).expect(400);
      }
    });

    it('never takes an account or customer from the request', async () => {
      const a = await accountFor(nextEmail());
      const b = await accountFor(nextEmail());
      const bCustomer = await db().customer.findUniqueOrThrow({
        where: { email: b.email },
      });
      for (const query of [
        { accountId: b.id },
        { storefrontAccountId: b.id },
        { customerId: bCustomer.id },
        { customerId: `CUS-${bCustomer.number}` },
        { email: b.email },
      ]) {
        await list(a.accessToken, query).expect(400);
      }
      // Headers are not read at all: still A's own (single) order.
      const res = await list(a.accessToken)
        .set('X-Account-Id', b.id)
        .set('X-Customer-Id', bCustomer.id)
        .expect(200);
      expect((res.body as Page).meta.total).toBe(1);
    });

    it('shows one order with what the shopper typed, and nothing internal', async () => {
      const email = nextEmail();
      const customer = await createCustomer(db(), {
        email,
        name: 'Ayesha Khan',
        phone: '0300 1234567',
      });
      const order = await confirmedOrder(email, {
        customer,
        recipientName: 'Ayesha at home',
      });
      const shopper = await accountFor(email);

      const res = await detail(
        shopper.accessToken,
        `ORD-${order.number}`,
      ).expect(200);
      const body = res.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        [
          ...SUMMARY_KEYS,
          'delivery',
          'discount',
          'items',
          'shipping',
          'subtotal',
          'tax',
        ].sort(),
      );
      expect(body).toMatchObject({
        id: `ORD-${order.number}`,
        total: 100,
        items: [
          {
            productId: 'PRD-1001',
            productName: 'Test Product',
            quantity: 1,
            unitPrice: 100,
            total: 100,
          },
        ],
        delivery: {
          contactName: 'Ayesha Khan',
          phone: '0300 1234567',
          address: { recipientName: 'Ayesha at home', city: 'Springfield' },
        },
      });
      const text = JSON.stringify(body);
      for (const secret of [
        order.id,
        customer.id,
        `CUS-${customer.number}`,
        shopper.id,
        'billingAddress',
        'idempotencyKey',
        'requestHash',
        'customerId',
        'confirmationEmail',
        'storefrontAccountId',
        'sku',
        'passwordHash',
      ]) {
        expect(text).not.toContain(secret);
      }
      // A lower-case reference names the same order.
      await detail(shopper.accessToken, `ord-${order.number}`).expect(200);
    });
  });

  describe('isolation', () => {
    it('answers another account’s order, a guessed number and a malformed id alike', async () => {
      const a = await accountFor(nextEmail());
      const b = await accountFor(nextEmail());
      const aOrder = await db().order.findFirstOrThrow({
        where: { storefrontAccountId: a.id },
      });
      const bOrder = await db().order.findFirstOrThrow({
        where: { storefrontAccountId: b.id },
      });

      const bList = (await list(b.accessToken).expect(200)).body as Page;
      expect(bList.data.map((o) => o.id)).toEqual([`ORD-${bOrder.number}`]);

      const notFound = (
        await detail(b.accessToken, `ORD-${aOrder.number}`).expect(404)
      ).body as unknown;
      for (const guess of [
        `ORD-${aOrder.number + 1}`,
        `ORD-${aOrder.number - 1}`,
        `ORD-${aOrder.number + 1000}`,
        'ORD-2147483647',
        'ORD-99999999999',
        'ORD-0',
        'ORD-01',
        `PRD-${aOrder.number}`,
        String(aOrder.number),
        aOrder.id,
        'nonsense',
      ]) {
        if (guess === `ORD-${bOrder.number}`) continue;
        const res = await detail(b.accessToken, guess).expect(404);
        expect(res.body).toEqual(notFound);
      }
      await detail(a.accessToken, `ORD-${aOrder.number}`).expect(200);
      await detail(b.accessToken, `ORD-${bOrder.number}`).expect(200);
    });

    it('needs a storefront session: no token, a staff token or a signed-out one are refused', async () => {
      const shopper = await accountFor(nextEmail());
      const order = await db().order.findFirstOrThrow({
        where: { storefrontAccountId: shopper.id },
      });
      await http().get('/storefront/account/orders').expect(401);
      await http()
        .get(`/storefront/account/orders/ORD-${order.number}`)
        .expect(401);

      await createUser(db(), { email: 'admin@example.com', role: 'ADMIN' });
      const staff = await login(ctx.app, 'admin@example.com');
      await list(staff.accessToken).expect(401);
      await detail(staff.accessToken, `ORD-${order.number}`).expect(401);

      await db().storefrontSession.updateMany({
        data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
      });
      await list(shopper.accessToken).expect(401);
    });

    it('is not there while accounts are switched off', async () => {
      const shopper = await accountFor(nextEmail());
      settings.accountsEnabled = false;
      const res = await list(shopper.accessToken).expect(404);
      expect(res.body).toMatchObject({
        message: 'Cannot GET /storefront/account/orders',
      });
      await detail(shopper.accessToken, 'ORD-1').expect(404);
    });
  });

  describe('which orders an account owns', () => {
    it('gives one account the orders of every customer record sharing the verified address, changing none of them', async () => {
      const email = nextEmail();
      // A legacy record with the address in another case, and another name;
      // the guest checkout's fallback match still files orders under it.
      const legacy = await createCustomer(db(), {
        email: email
          .replace('shopper', 'Shopper')
          .replace('example', 'EXAMPLE'),
        name: 'A. Khan',
      });
      const current = await createCustomer(db(), {
        email,
        name: 'Ayesha Khan',
      });
      const viaLegacy = await confirmedOrder(email, {
        customer: legacy,
        recipientName: 'A. Khan',
      });
      const viaCurrent = await confirmedOrder(email, {
        customer: current,
        recipientName: 'Ayesha Khan',
      });
      const before = await db().order.findMany({
        where: { id: { in: [viaLegacy.id, viaCurrent.id] } },
        orderBy: { number: 'asc' },
        select: {
          customerId: true,
          customerName: true,
          customerEmail: true,
          shippingAddress: true,
          billingAddress: true,
        },
      });

      const shopper = await accountFor(email);

      const page = (await list(shopper.accessToken).expect(200)).body as Page;
      expect(page.data.map((o) => o.id).sort()).toEqual(
        [`ORD-${viaLegacy.number}`, `ORD-${viaCurrent.number}`].sort(),
      );
      expect(await db().storefrontAccount.count()).toBe(1);
      // The customer records and the orders' snapshots are as they were.
      await expect(
        db().customer.findMany({
          orderBy: { number: 'asc' },
          select: { id: true, name: true, email: true },
        }),
      ).resolves.toEqual([
        { id: legacy.id, name: 'A. Khan', email: legacy.email },
        { id: current.id, name: 'Ayesha Khan', email },
      ]);
      await expect(
        db().order.findMany({
          where: { id: { in: [viaLegacy.id, viaCurrent.id] } },
          orderBy: { number: 'asc' },
          select: {
            customerId: true,
            customerName: true,
            customerEmail: true,
            shippingAddress: true,
            billingAddress: true,
          },
        }),
      ).resolves.toEqual(before);
      const legacyDetail = await detail(
        shopper.accessToken,
        `ORD-${viaLegacy.number}`,
      ).expect(200);
      expect(legacyDetail.body).toMatchObject({
        delivery: {
          contactName: 'A. Khan',
          address: { recipientName: 'A. Khan' },
        },
      });
    });

    it('never attaches legacy or unconfirmed orders that only share the email text', async () => {
      const email = nextEmail();
      const customer = await customerFor(email);
      const legacyCase = await createCustomer(db(), {
        email: email.toUpperCase(),
      });
      const now = Date.now();
      const exempt = await createOrder(db(), customer, { status: 'DELIVERED' });
      const exemptLegacy = await createOrder(db(), legacyCase, {
        status: 'DELIVERED',
      });
      const awaiting = await createOrder(db(), customer, {
        status: 'PENDING',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email,
          expiresAt: new Date(now + HOUR_MS),
        },
      });
      const expired = await createOrder(db(), customer, {
        status: 'CANCELLED',
        confirmation: {
          status: 'EXPIRED',
          email,
          expiresAt: new Date(now - 1000),
        },
      });
      const confirmed = await confirmedOrder(email, { customer });

      const shopper = await accountFor(email);
      const page = (await list(shopper.accessToken).expect(200)).body as Page;
      expect(page.data.map((o) => o.id)).toEqual([`ORD-${confirmed.number}`]);
      for (const other of [exempt, exemptLegacy, awaiting, expired]) {
        expect(await ownerOf(other.id)).toBeNull();
        await detail(shopper.accessToken, `ORD-${other.number}`).expect(404);
      }
    });

    it('is enforced by the database too', async () => {
      const email = nextEmail();
      const shopper = await accountFor(email);
      const customer = await customerFor(email);
      const exempt = await createOrder(db(), customer);
      const awaiting = await createOrder(db(), customer, {
        status: 'PENDING',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email,
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });
      const elsewhere = await confirmedOrder(nextEmail());

      for (const order of [exempt, awaiting]) {
        await expect(
          db().order.update({
            where: { id: order.id },
            data: { storefrontAccountId: shopper.id },
          }),
        ).rejects.toThrow(/Order_storefront_account_check/);
      }
      // Confirmed, but by another inbox.
      await expect(
        db().order.update({
          where: { id: elsewhere.id },
          data: { storefrontAccountId: shopper.id },
        }),
      ).rejects.toThrow(/address that confirmed it/);
      // And an account's address cannot be swapped under its orders.
      await expect(
        db().storefrontAccount.update({
          where: { id: shopper.id },
          data: { email: 'someone-else@example.com' },
        }),
      ).rejects.toThrow(/StorefrontAccount.email cannot change/);
    });

    it('links at once an order confirmed after the account exists, and reconciles one the account missed', async () => {
      const email = nextEmail();
      const shopper = await accountFor(email);
      // Confirmation links it when the account already exists (Step 5).
      const linked = await confirmedOrder(email, { accountId: shopper.id });
      // The race the history reconciles: confirmed while the account was being
      // created, so it was recorded with no owner.
      const missed = await confirmedOrder(email);
      const someoneElses = await confirmedOrder(nextEmail());
      expect(await ownerOf(missed.id)).toBeNull();

      await detail(shopper.accessToken, `ORD-${missed.number}`).expect(200);
      expect(await ownerOf(missed.id)).toBe(shopper.id);
      const page = (await list(shopper.accessToken).expect(200)).body as Page;
      expect(page.meta.total).toBe(3);
      expect(page.data.map((o) => o.id)).toEqual(
        expect.arrayContaining([
          `ORD-${linked.number}`,
          `ORD-${missed.number}`,
        ]),
      );
      expect(await ownerOf(someoneElses.id)).toBeNull();
    });

    it('reads a page straight off the history index', async () => {
      const shopper = await accountFor(nextEmail());
      const plan = await db().$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT "number" FROM "Order"
           WHERE "storefrontAccountId" = $1 AND "confirmationStatus" = 'CONFIRMED'
           ORDER BY "createdAt" DESC, "number" DESC LIMIT 10 OFFSET 0`,
          shopper.id,
        );
      });
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).toContain('Order_storefrontAccountId_createdAt_number_idx');
      expect(text).not.toMatch(/\bSort\b/);
    });
  });
});
