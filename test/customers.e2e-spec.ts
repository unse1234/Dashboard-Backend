import request from 'supertest';
import {
  bearer,
  createAddress,
  createCustomer,
  createOrder,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

const LIST_ITEM_FIELDS = [
  'email',
  'id',
  'joinedAt',
  'lastOrderAt',
  'name',
  'phone',
  'totalOrders',
  'totalSpent',
];
const ADDRESS_FIELDS = [
  'addressLine1',
  'addressLine2',
  'city',
  'country',
  'customerId',
  'id',
  'isDefault',
  'phone',
  'postalCode',
  'recipientName',
  'region',
  'type',
];
const ORDER_SUMMARY_FIELDS = [
  'createdAt',
  'currency',
  'customerId',
  'id',
  'status',
  'total',
];

interface ListItem {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  joinedAt: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: string | null;
}

const at = (iso: string) => new Date(iso);
const keysOf = (value: unknown) => Object.keys(value as object).sort();
const cus = (customer: { number: number }) => `CUS-${customer.number}`;
const idsOf = (res: { body: unknown }): string[] =>
  (res.body as { data: ListItem[] }).data.map((c) => c.id);

describe('Customers (e2e)', () => {
  let ctx: TestContext;
  let token: string;
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string) => http().get(path).set(bearer(token));

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, { email: 'admin@example.com', role: 'ADMIN' });
    token = (await login(ctx.app, 'admin@example.com')).accessToken;
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  // Keeps the signed-in admin; only the customer data starts over.
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "OrderEvent", "OrderItem", "Order", "CustomerAddress", "Customer"',
    );
  });

  describe('access control', () => {
    it('requires authentication on both routes', async () => {
      await http().get('/customers').expect(401);
      await http().get('/customers/CUS-1001').expect(401);
      await http()
        .get('/customers')
        .set(bearer('not-a-real-token'))
        .expect(401);
    });

    it('blocks a user whose email is not verified', async () => {
      await createUser(ctx.prisma, {
        email: 'unverified@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'unverified@example.com');
      for (const path of ['/customers', '/customers/CUS-1001']) {
        const res = await http().get(path).set(bearer(accessToken)).expect(403);
        expect(res.body.message).toBe('Email verification required');
      }
    });

    it('lets staff as well as admins view customers', async () => {
      const customer = await createCustomer(ctx.prisma);
      await createUser(ctx.prisma, { email: 'staff@example.com' });
      const { accessToken } = await login(ctx.app, 'staff@example.com');
      await http().get('/customers').set(bearer(accessToken)).expect(200);
      await http()
        .get(`/customers/${cus(customer)}`)
        .set(bearer(accessToken))
        .expect(200);
      await get('/customers').expect(200);
    });

    it('offers no way to create, change or delete customers', async () => {
      const customer = await createCustomer(ctx.prisma);
      await http()
        .post('/customers')
        .set(bearer(token))
        .send({ name: 'X', email: 'x@example.com' })
        .expect(404);
      await http()
        .patch(`/customers/${cus(customer)}`)
        .set(bearer(token))
        .send({ name: 'X' })
        .expect(404);
      await http()
        .delete(`/customers/${cus(customer)}`)
        .set(bearer(token))
        .expect(404);
    });
  });

  describe('GET /customers', () => {
    it('returns an empty first page when there are no customers', async () => {
      const res = await get('/customers').expect(200);
      expect(res.body).toEqual({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
      });
    });

    it('returns exactly the allowlisted fields and never an internal id', async () => {
      const customer = await createCustomer(ctx.prisma, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+1 555 0100',
        createdAt: at('2026-01-02T03:04:05.000Z'),
      });
      const order = await createOrder(ctx.prisma, customer, {
        total: 42.5,
        createdAt: at('2026-02-01T00:00:00.000Z'),
      });
      const res = await get('/customers').expect(200);

      expect(keysOf(res.body)).toEqual(['data', 'meta']);
      expect(keysOf(res.body.data[0])).toEqual(LIST_ITEM_FIELDS);
      expect(res.body.data[0]).toEqual({
        id: cus(customer),
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+1 555 0100',
        joinedAt: '2026-01-02T03:04:05.000Z',
        totalOrders: 1,
        totalSpent: 42.5,
        lastOrderAt: '2026-02-01T00:00:00.000Z',
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(customer.id);
      expect(raw).not.toContain(order.id);
    });

    it('lists the newest customers first by default', async () => {
      const old = await createCustomer(ctx.prisma, {
        createdAt: at('2025-01-01T00:00:00Z'),
      });
      const recent = await createCustomer(ctx.prisma, {
        createdAt: at('2026-06-01T00:00:00Z'),
      });
      const middle = await createCustomer(ctx.prisma, {
        createdAt: at('2025-06-01T00:00:00Z'),
      });
      const res = await get('/customers').expect(200);
      expect(idsOf(res)).toEqual([cus(recent), cus(middle), cus(old)]);
    });

    it('pages with correct meta and an empty page past the end', async () => {
      for (let i = 0; i < 25; i++) {
        await createCustomer(ctx.prisma, {
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        });
      }
      const page3 = await get('/customers?page=3&pageSize=10').expect(200);
      expect(page3.body.data).toHaveLength(5);
      expect(page3.body.meta).toEqual({
        page: 3,
        pageSize: 10,
        total: 25,
        totalPages: 3,
      });

      const past = await get('/customers?page=4&pageSize=10').expect(200);
      expect(past.body).toEqual({
        data: [],
        meta: { page: 4, pageSize: 10, total: 25, totalPages: 3 },
      });
    });

    it('never repeats or skips a customer across pages, even when sort values tie', async () => {
      const sameDay = at('2026-03-03T00:00:00Z');
      const created: string[] = [];
      for (let i = 0; i < 7; i++) {
        created.push(
          cus(await createCustomer(ctx.prisma, { createdAt: sameDay })),
        );
      }
      for (const query of ['', '&sortBy=totalOrders', '&sortBy=joinedAt']) {
        const seen: string[] = [];
        for (let page = 1; page <= 4; page++) {
          seen.push(
            ...idsOf(await get(`/customers?pageSize=2&page=${page}${query}`)),
          );
        }
        expect(seen).toHaveLength(7);
        expect([...seen].sort()).toEqual([...created].sort());

        // The same request always gives the same order.
        const again: string[] = [];
        for (let page = 1; page <= 4; page++) {
          again.push(
            ...idsOf(await get(`/customers?pageSize=2&page=${page}${query}`)),
          );
        }
        expect(again).toEqual(seen);
      }
    });

    describe('search', () => {
      let ada: Awaited<ReturnType<typeof createCustomer>>;
      let grace: Awaited<ReturnType<typeof createCustomer>>;
      let alan: Awaited<ReturnType<typeof createCustomer>>;

      beforeEach(async () => {
        ada = await createCustomer(ctx.prisma, {
          name: 'Ada Lovelace',
          email: 'ada@analytical.example',
          phone: '+44 20 7946 0001',
        });
        grace = await createCustomer(ctx.prisma, {
          name: 'Grace Hopper',
          email: 'grace_h@navy.example',
          phone: null,
        });
        alan = await createCustomer(ctx.prisma, {
          name: '100% Alan',
          email: 'alan@bletchley.example',
          phone: '555-0199',
        });
      });

      const search = async (term: string) =>
        idsOf(
          await get(`/customers?search=${encodeURIComponent(term)}`).expect(
            200,
          ),
        ).sort();

      it('matches the name, email or phone, in any case', async () => {
        expect(await search('lovelace')).toEqual([cus(ada)]);
        expect(await search('HOPPER')).toEqual([cus(grace)]);
        expect(await search('Bletchley')).toEqual([cus(alan)]);
        expect(await search('7946')).toEqual([cus(ada)]);
        expect(await search('example')).toEqual(
          [cus(ada), cus(grace), cus(alan)].sort(),
        );
        expect(await search('nobody')).toEqual([]);
      });

      it('matches a customer id with or without the prefix, in any case', async () => {
        expect(await search(cus(grace))).toEqual([cus(grace)]);
        expect(await search(cus(grace).toLowerCase())).toEqual([cus(grace)]);
        expect(await search(String(grace.number))).toEqual([cus(grace)]);
      });

      it('treats % and _ literally', async () => {
        expect(await search('%')).toEqual([cus(alan)]);
        expect(await search('_')).toEqual([cus(grace)]);
        expect(await search('grace_h')).toEqual([cus(grace)]);
      });

      it('trims the term and reports the filtered total', async () => {
        const res = await get('/customers?search=%20%20hopper%20%20').expect(
          200,
        );
        expect(idsOf(res)).toEqual([cus(grace)]);
        expect(res.body.meta.total).toBe(1);
      });
    });

    describe('sorting', () => {
      // Each column orders these three differently, so a wrong mapping shows.
      let a: string;
      let b: string;
      let c: string;

      beforeEach(async () => {
        const first = await createCustomer(ctx.prisma, {
          name: 'carol',
          email: 'b@example.com',
          createdAt: at('2026-02-01T00:00:00Z'),
        });
        const second = await createCustomer(ctx.prisma, {
          name: 'Alice',
          email: 'c@example.com',
          createdAt: at('2026-03-01T00:00:00Z'),
        });
        const third = await createCustomer(ctx.prisma, {
          name: 'Bob',
          email: 'a@example.com',
          createdAt: at('2026-01-01T00:00:00Z'),
        });
        [a, b, c] = [first, second, third].map(cus);

        // first: 2 orders, 20 spent. second: 1 order, 300 spent. third: 3 orders, 5 spent.
        await createOrder(ctx.prisma, first, { total: 10 });
        await createOrder(ctx.prisma, first, { total: 10 });
        await createOrder(ctx.prisma, second, { total: 300 });
        await createOrder(ctx.prisma, third, { total: 5 });
        await createOrder(ctx.prisma, third, {
          total: 99,
          status: 'CANCELLED',
        });
        await createOrder(ctx.prisma, third, { total: 0 });
      });

      it.each([
        ['id', () => [a, b, c]],
        ['name', () => [b, c, a]], // case-insensitive: Alice, Bob, carol
        ['email', () => [c, a, b]],
        ['totalOrders', () => [b, a, c]],
        ['totalSpent', () => [c, a, b]],
        ['joinedAt', () => [c, a, b]],
      ] as const)(
        'sorts by %s in both directions',
        async (sortBy, expected) => {
          const asc = await get(`/customers?sortBy=${sortBy}`).expect(200);
          expect(idsOf(asc)).toEqual(expected());
          const explicitAsc = await get(
            `/customers?sortBy=${sortBy}&sortOrder=asc`,
          ).expect(200);
          expect(idsOf(explicitAsc)).toEqual(expected());
          const desc = await get(
            `/customers?sortBy=${sortBy}&sortOrder=desc`,
          ).expect(200);
          expect(idsOf(desc)).toEqual([...expected()].reverse());
        },
      );

      it('ignores sortOrder without sortBy', async () => {
        const res = await get('/customers?sortOrder=asc').expect(200);
        expect(idsOf(res)).toEqual([b, a, c]);
      });
    });

    it('computes order statistics from the orders', async () => {
      const buyer = await createCustomer(ctx.prisma, { name: 'Buyer' });
      await createOrder(ctx.prisma, buyer, {
        total: 10.05,
        createdAt: at('2026-01-01T00:00:00Z'),
      });
      await createOrder(ctx.prisma, buyer, {
        total: 10.05,
        status: 'PENDING',
        createdAt: at('2026-01-02T00:00:00Z'),
      });
      await createOrder(ctx.prisma, buyer, {
        total: 10.05,
        shipping: 2.5,
        discount: 1.1,
        tax: 0.8,
        status: 'SHIPPED',
        createdAt: at('2026-01-03T00:00:00Z'),
      });
      // Counted, but not spent; still the latest order.
      await createOrder(ctx.prisma, buyer, {
        total: 500,
        status: 'CANCELLED',
        createdAt: at('2026-01-04T00:00:00Z'),
      });
      const browser = await createCustomer(ctx.prisma, { name: 'Browser' });

      const res = await get('/customers?sortBy=name').expect(200);
      const [browserRow, buyerRow] = res.body.data as ListItem[];
      expect(buyerRow).toMatchObject({
        id: cus(buyer),
        totalOrders: 4,
        totalSpent: 30.15,
        lastOrderAt: '2026-01-04T00:00:00.000Z',
      });
      expect(browserRow).toMatchObject({
        id: cus(browser),
        totalOrders: 0,
        totalSpent: 0,
        lastOrderAt: null,
      });
    });

    it.each([
      ['page=0'],
      ['page=abc'],
      ['pageSize=0'],
      ['pageSize=101'],
      ['sortBy=phone'],
      ['sortBy=totalOrders&sortOrder=down'],
      [`search=${'a'.repeat(101)}`],
      ['status=active'],
    ])('rejects %s with 400', async (query) => {
      const res = await get(`/customers?${query}`).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    });
  });

  describe('GET /customers/:customerId', () => {
    it('returns the customer, their addresses and their three latest orders', async () => {
      const customer = await createCustomer(ctx.prisma, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: null,
        createdAt: at('2025-12-01T00:00:00Z'),
      });
      // Created out of order to prove the response orders them.
      const billing = await createAddress(ctx.prisma, customer.id, {
        type: 'BILLING',
        isDefault: true,
        createdAt: at('2025-12-01T00:00:00Z'),
      });
      const otherShipping = await createAddress(ctx.prisma, customer.id, {
        type: 'SHIPPING',
        createdAt: at('2025-12-02T00:00:00Z'),
      });
      const defaultShipping = await createAddress(ctx.prisma, customer.id, {
        type: 'SHIPPING',
        isDefault: true,
        createdAt: at('2025-12-03T00:00:00Z'),
      });
      const oldestShipping = await createAddress(ctx.prisma, customer.id, {
        type: 'SHIPPING',
        createdAt: at('2025-12-01T00:00:00Z'),
      });

      const orders = [];
      for (const [day, status] of [
        [1, 'DELIVERED'],
        [4, 'CANCELLED'],
        [2, 'SHIPPED'],
        [5, 'PENDING'],
        [3, 'PROCESSING'],
      ] as const) {
        orders.push(
          await createOrder(ctx.prisma, customer, {
            total: day * 10,
            status,
            createdAt: new Date(Date.UTC(2026, 0, day)),
          }),
        );
      }
      const [day1, day4, , day5, day3] = orders;

      const res = await get(`/customers/${cus(customer)}`).expect(200);
      expect(keysOf(res.body)).toEqual([
        'addresses',
        'customer',
        'recentOrders',
      ]);
      expect(res.body.customer).toEqual({
        id: cus(customer),
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: null,
        joinedAt: '2025-12-01T00:00:00.000Z',
        totalOrders: 5,
        totalSpent: 10 + 20 + 30 + 50,
        lastOrderAt: '2026-01-05T00:00:00.000Z',
      });

      expect((res.body.addresses as { id: string }[]).map((a) => a.id)).toEqual(
        [defaultShipping.id, oldestShipping.id, otherShipping.id, billing.id],
      );
      for (const address of res.body.addresses) {
        expect(keysOf(address)).toEqual(ADDRESS_FIELDS);
      }
      expect(res.body.addresses[0]).toEqual({
        id: defaultShipping.id,
        customerId: cus(customer),
        type: 'SHIPPING',
        recipientName: 'Test Recipient',
        phone: null,
        addressLine1: '1 Test Street',
        addressLine2: null,
        city: 'Springfield',
        region: null,
        postalCode: '12345',
        country: 'United States',
        isDefault: true,
      });

      expect(res.body.recentOrders).toEqual([
        {
          id: `ORD-${day5.number}`,
          customerId: cus(customer),
          total: 50,
          currency: 'USD',
          status: 'PENDING',
          createdAt: '2026-01-05T00:00:00.000Z',
        },
        {
          id: `ORD-${day4.number}`,
          customerId: cus(customer),
          total: 40,
          currency: 'USD',
          status: 'CANCELLED',
          createdAt: '2026-01-04T00:00:00.000Z',
        },
        {
          id: `ORD-${day3.number}`,
          customerId: cus(customer),
          total: 30,
          currency: 'USD',
          status: 'PROCESSING',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ]);
      for (const order of res.body.recentOrders) {
        expect(keysOf(order)).toEqual(ORDER_SUMMARY_FIELDS);
      }

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(customer.id);
      for (const order of orders) expect(raw).not.toContain(order.id);
      expect(raw).not.toContain(day1.id);
    });

    it('returns a customer with no orders or addresses', async () => {
      const customer = await createCustomer(ctx.prisma);
      const res = await get(`/customers/${cus(customer)}`).expect(200);
      expect(res.body).toMatchObject({
        customer: { totalOrders: 0, totalSpent: 0, lastOrderAt: null },
        addresses: [],
        recentOrders: [],
      });
    });

    it('accepts the id in any case', async () => {
      const customer = await createCustomer(ctx.prisma);
      const res = await get(`/customers/${cus(customer).toLowerCase()}`).expect(
        200,
      );
      expect(res.body.customer.id).toBe(cus(customer));
    });

    it('does not mix in another customer’s data', async () => {
      const one = await createCustomer(ctx.prisma);
      const two = await createCustomer(ctx.prisma);
      await createAddress(ctx.prisma, two.id);
      await createOrder(ctx.prisma, two);
      const res = await get(`/customers/${cus(one)}`).expect(200);
      expect(res.body.addresses).toEqual([]);
      expect(res.body.recentOrders).toEqual([]);
      expect(res.body.customer.totalOrders).toBe(0);
    });

    it('returns 404 for an unknown customer', async () => {
      const res = await get('/customers/CUS-999999').expect(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: 'Customer not found',
        error: 'Not Found',
      });
    });

    it.each([
      'abc',
      '1001',
      'CUS-0',
      'CUS-01001',
      'CUS-1001x',
      'CUS-99999999999',
      '00000000-0000-4000-8000-000000000000',
    ])('rejects the malformed id %j with 400', async (id) => {
      await get(`/customers/${encodeURIComponent(id)}`).expect(400);
    });
  });
});
