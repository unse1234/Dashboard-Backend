import request from 'supertest';
import {
  bearer,
  createCustomer,
  createOrder,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

const LIST_ITEM_FIELDS = [
  'createdAt',
  'customer',
  'id',
  'itemCount',
  'paymentStatus',
  'status',
  'total',
];
const DETAIL_FIELDS = [
  ...LIST_ITEM_FIELDS,
  'billingAddress',
  'discount',
  'items',
  'shipping',
  'shippingAddress',
  'subtotal',
  'tax',
  'updatedAt',
].sort();
const ITEM_FIELDS = [
  'id',
  'productId',
  'productName',
  'quantity',
  'sku',
  'total',
  'unitPrice',
];
const ADDRESS_FIELDS = [
  'addressLine1',
  'addressLine2',
  'city',
  'country',
  'phone',
  'postalCode',
  'recipientName',
  'region',
];

interface OrderBody {
  id: string;
  customer: { id: string; name: string; email: string; phone: string | null };
  status: string;
  paymentStatus: string;
  itemCount: number;
  total: number;
  createdAt: string;
  items?: Record<string, unknown>[];
  subtotal?: number;
  billingAddress?: Record<string, unknown>;
  shippingAddress?: Record<string, unknown>;
}

const keysOf = (value: unknown) => Object.keys(value as object).sort();
const ord = (order: { number: number }) => `ORD-${order.number}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

describe('Orders (e2e)', () => {
  let ctx: TestContext;
  let adminToken: string;
  let staffToken: string;
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string, token = adminToken) =>
    http().get(path).set(bearer(token));
  const patch = (path: string, body: object, token = adminToken) =>
    http().patch(path).set(bearer(token)).send(body);

  const idsOf = (res: { body: unknown }): string[] =>
    (res.body as { data: OrderBody[] }).data.map((o) => o.id);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'ADMIN',
    });
    await createUser(ctx.prisma, {
      email: 'staff@example.com',
      name: 'Sam Staff',
      role: 'STAFF',
    });
    adminToken = (await login(ctx.app, 'admin@example.com')).accessToken;
    staffToken = (await login(ctx.app, 'staff@example.com')).accessToken;
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  // Keeps the signed-in users; only the shop's data starts over.
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "Order", "CustomerAddress", "Customer", "Product"',
    );
  });

  async function placedOrder(
    options: Parameters<typeof createOrder>[2] = {},
    customerOptions: Parameters<typeof createCustomer>[1] = {},
  ) {
    const customer = await createCustomer(ctx.prisma, customerOptions);
    const order = await createOrder(ctx.prisma, customer, options);
    return { customer, order };
  }

  describe('access control', () => {
    const routes: [string, string][] = [
      ['get', '/orders'],
      ['get', '/orders/ORD-10001'],
      ['post', '/orders'],
      ['patch', '/orders/ORD-10001/status'],
      ['patch', '/orders/ORD-10001/payment-status'],
    ];

    it('requires authentication on every route', async () => {
      for (const [method, path] of routes) {
        const verb = method as 'get' | 'post' | 'patch';
        await http()[verb](path).expect(401);
        await http()[verb](path).set(bearer('not-a-real-token')).expect(401);
      }
    });

    it('blocks a user whose email is not verified', async () => {
      await createUser(ctx.prisma, {
        email: 'unverified@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'unverified@example.com');
      const res = await get('/orders', accessToken).expect(403);
      expect(res.body.message).toBe('Email verification required');
    });

    it('lets staff view orders and move them along', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });
      await get('/orders', staffToken).expect(200);
      await get(`/orders/${ord(order)}`, staffToken).expect(200);
      await patch(
        `/orders/${ord(order)}/payment-status`,
        { paymentStatus: 'PAID' },
        staffToken,
      ).expect(200);
      await patch(
        `/orders/${ord(order)}/status`,
        { status: 'PROCESSING' },
        staffToken,
      ).expect(200);
    });

    it('keeps placing orders for administrators', async () => {
      const res = await http()
        .post('/orders')
        .set(bearer(staffToken))
        .set('Idempotency-Key', 'staff-attempt-0001')
        .send({})
        .expect(403);
      expect(res.body.message).toBe('Insufficient permissions');
    });

    it('offers no way to delete an order', async () => {
      const { order } = await placedOrder();
      await http()
        .delete(`/orders/${ord(order)}`)
        .set(bearer(adminToken))
        .expect(404);
      expect(await ctx.prisma.order.count()).toBe(1);
    });
  });

  describe('GET /orders', () => {
    it('returns the orders with exactly the fields the dashboard lists', async () => {
      const { customer, order } = await placedOrder(
        { total: 82.5, status: 'SHIPPED' },
        {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          phone: '+1 555 0100',
        },
      );
      const res = await get('/orders').expect(200);
      const body = res.body as {
        data: OrderBody[];
        meta: Record<string, number>;
      };

      expect(body.meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      });
      expect(keysOf(body.data[0])).toEqual(LIST_ITEM_FIELDS);
      expect(keysOf(body.data[0].customer)).toEqual([
        'email',
        'id',
        'name',
        'phone',
      ]);
      expect(body.data[0]).toEqual({
        id: ord(order),
        customer: {
          id: `CUS-${customer.number}`,
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          phone: '+1 555 0100',
        },
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        itemCount: 1,
        total: 82.5,
        createdAt: order.createdAt.toISOString(),
      });
    });

    it('lists the newest first and pages without overlap', async () => {
      const made = [];
      for (let i = 0; i < 5; i++) {
        const { order } = await placedOrder({ createdAt: daysAgo(5 - i) });
        made.push(order);
      }
      const newestFirst = [...made].reverse().map(ord);

      const first = await get('/orders?pageSize=2').expect(200);
      expect(idsOf(first)).toEqual(newestFirst.slice(0, 2));
      expect(first.body.meta).toEqual({
        page: 1,
        pageSize: 2,
        total: 5,
        totalPages: 3,
      });
      expect(idsOf(await get('/orders?pageSize=2&page=2'))).toEqual(
        newestFirst.slice(2, 4),
      );
      expect(idsOf(await get('/orders?pageSize=2&page=3'))).toEqual(
        newestFirst.slice(4),
      );
    });

    it('returns an empty page, with the true totals, past the end', async () => {
      await placedOrder();
      const res = await get('/orders?page=9').expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ page: 9, total: 1, totalPages: 1 });
    });

    it('counts units, not lines', async () => {
      const mug = await createProduct(ctx.prisma);
      const pan = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      await createOrder(ctx.prisma, customer, {
        items: [
          { product: mug, quantity: 2 },
          { product: pan, quantity: 3 },
        ],
      });
      const res = await get('/orders').expect(200);
      expect((res.body as { data: OrderBody[] }).data[0].itemCount).toBe(5);
    });

    describe('search', () => {
      let ada: { number: number };

      beforeEach(async () => {
        ({ order: ada } = await placedOrder(
          {},
          { name: 'Ada Lovelace', email: 'ada@analytical.example' },
        ));
        await placedOrder(
          {},
          { name: 'Grace Hopper', email: 'grace@navy.example' },
        );
        await placedOrder(
          {},
          { name: '100% Fan_Club', email: 'fan@club.example' },
        );
      });

      const names = async (search: string) =>
        (
          (
            await get(`/orders?search=${encodeURIComponent(search)}`).expect(
              200,
            )
          ).body as { data: OrderBody[] }
        ).data
          .map((o) => o.customer.name)
          .sort();

      it("matches the customer's name, in any case", async () => {
        expect(await names('lovelace')).toEqual(['Ada Lovelace']);
        expect(await names('GRACE')).toEqual(['Grace Hopper']);
      });

      it("matches the customer's email", async () => {
        expect(await names('navy.example')).toEqual(['Grace Hopper']);
      });

      it('treats % and _ literally', async () => {
        expect(await names('100%')).toEqual(['100% Fan_Club']);
        expect(await names('%')).toEqual(['100% Fan_Club']);
        expect(await names('Fan_C')).toEqual(['100% Fan_Club']);
        expect(await names('Fan%C')).toEqual([]);
      });

      it('finds an order by its id, with or without the prefix', async () => {
        for (const term of [
          `ORD-${ada.number}`,
          `ord-${ada.number}`,
          `ord${ada.number}`,
          String(ada.number),
        ]) {
          expect(await names(term)).toContain('Ada Lovelace');
        }
      });

      it('ignores surrounding spaces and returns nothing for no match', async () => {
        expect(await names('  hopper  ')).toEqual(['Grace Hopper']);
        expect(await names('zzz-nothing')).toEqual([]);
      });
    });

    describe('filters', () => {
      it('narrows to a status and to a payment status', async () => {
        const { order: pending } = await placedOrder({
          status: 'PENDING',
          paymentStatus: 'PENDING',
        });
        const { order: paidPending } = await placedOrder({
          status: 'PENDING',
          paymentStatus: 'PAID',
        });
        await placedOrder({ status: 'DELIVERED' });

        expect(idsOf(await get('/orders?status=PENDING')).sort()).toEqual(
          [ord(pending), ord(paidPending)].sort(),
        );
        expect(idsOf(await get('/orders?paymentStatus=PENDING'))).toEqual([
          ord(pending),
        ]);
        expect(
          idsOf(await get('/orders?status=PENDING&paymentStatus=PAID')),
        ).toEqual([ord(paidPending)]);
      });

      it("narrows to one customer's orders", async () => {
        const customer = await createCustomer(ctx.prisma);
        const mine = [
          await createOrder(ctx.prisma, customer, { createdAt: daysAgo(2) }),
          await createOrder(ctx.prisma, customer, { createdAt: daysAgo(1) }),
        ];
        await placedOrder();

        const res = await get(
          `/orders?customerId=CUS-${customer.number}`,
        ).expect(200);
        expect(idsOf(res)).toEqual([...mine].reverse().map(ord));
        expect(res.body.meta.total).toBe(2);

        const none = await get('/orders?customerId=CUS-999999').expect(200);
        expect(none.body.data).toEqual([]);
      });
    });

    describe('sorting', () => {
      let zed: { number: number };
      let ada: { number: number };
      let mia: { number: number };

      beforeEach(async () => {
        const mug = await createProduct(ctx.prisma);
        const make = async (
          name: string,
          days: number,
          options: Parameters<typeof createOrder>[2],
        ) => {
          const customer = await createCustomer(ctx.prisma, { name });
          return createOrder(ctx.prisma, customer, {
            createdAt: daysAgo(days),
            ...options,
          });
        };
        zed = await make('Zed', 3, {
          status: 'PENDING',
          paymentStatus: 'PENDING',
          items: [{ product: mug, quantity: 1 }],
        });
        // A lower-case name must sort among the others, not after "Zed".
        ada = await make('ada', 2, {
          status: 'SHIPPED',
          paymentStatus: 'PAID',
          items: [{ product: mug, quantity: 3 }],
          shipping: 5,
        });
        mia = await make('Mia', 1, {
          status: 'DELIVERED',
          paymentStatus: 'PAID',
          items: [{ product: mug, quantity: 2 }],
        });
      });

      const sorted = async (sortBy: string, sortOrder = 'asc') =>
        idsOf(
          await get(`/orders?sortBy=${sortBy}&sortOrder=${sortOrder}`).expect(
            200,
          ),
        );

      it.each([
        ['id', ['zed', 'ada', 'mia']],
        ['customer', ['ada', 'mia', 'zed']],
        ['createdAt', ['zed', 'ada', 'mia']],
        ['itemCount', ['zed', 'mia', 'ada']],
        ['total', ['zed', 'mia', 'ada']],
        ['paymentStatus', ['zed', 'ada', 'mia']],
        ['status', ['zed', 'ada', 'mia']],
      ] as const)('sorts by %s, both ways', async (column, expected) => {
        const byName = { zed, ada, mia };
        const ascending = expected.map((name) => ord(byName[name]));
        expect(await sorted(column, 'asc')).toEqual(
          // Ties (equal payment statuses) fall back to newest first.
          column === 'paymentStatus'
            ? [ord(zed), ord(mia), ord(ada)]
            : ascending,
        );
        expect(await sorted(column, 'desc')).toEqual(
          column === 'paymentStatus'
            ? [ord(mia), ord(ada), ord(zed)]
            : [...ascending].reverse(),
        );
      });

      it('sorts ascending when only the column is given', async () => {
        expect(idsOf(await get('/orders?sortBy=customer').expect(200))).toEqual(
          [ord(ada), ord(mia), ord(zed)],
        );
      });

      it('keeps pages stable when many orders tie on the sort column', async () => {
        const customer = await createCustomer(ctx.prisma);
        const sameTotal = [];
        for (let i = 0; i < 6; i++) {
          sameTotal.push(
            await createOrder(ctx.prisma, customer, {
              total: 77,
              createdAt: daysAgo(10 + i),
            }),
          );
        }
        const seen: string[] = [];
        for (let page = 1; page <= 3; page++) {
          const res = await get(
            `/orders?sortBy=total&sortOrder=desc&pageSize=3&page=${page}`,
          ).expect(200);
          seen.push(...idsOf(res));
        }
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(9);
      });
    });

    it.each([
      ['page 0', 'page=0'],
      ['pageSize 101', 'pageSize=101'],
      ['an unknown status', 'status=SENT'],
      ['a lower-case status', 'status=pending'],
      ['an unknown payment status', 'paymentStatus=OWED'],
      ['a customer id that is malformed', 'customerId=1001'],
      ['an unknown sort column', 'sortBy=customerName'],
      ['an unknown sort order', 'sortOrder=up'],
      ['an over-long search', `search=${'a'.repeat(101)}`],
      ['an unknown parameter', 'from=2026-01-01'],
    ])('answers 400 for %s', async (_label, query) => {
      await get(`/orders?${query}`).expect(400);
    });
  });

  describe('GET /orders/:orderId', () => {
    it('returns the order as the details page shows it', async () => {
      const mug = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        sku: 'MUG-1',
        price: '19.99',
      });
      const pan = await createProduct(ctx.prisma, {
        name: 'Skillet',
        sku: 'PAN-1',
        price: '39.95',
      });
      const customer = await createCustomer(ctx.prisma, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: null,
      });
      const order = await createOrder(ctx.prisma, customer, {
        shipping: 4.99,
        discount: 1,
        tax: 5.1,
        items: [
          { product: mug, quantity: 3 },
          { product: pan, quantity: 1 },
        ],
      });

      const res = await get(`/orders/${ord(order)}`).expect(200);
      const body = res.body as OrderBody;

      expect(keysOf(body)).toEqual(DETAIL_FIELDS);
      expect(keysOf(body.items?.[0])).toEqual(ITEM_FIELDS);
      expect(keysOf(body.billingAddress)).toEqual(ADDRESS_FIELDS);
      expect(keysOf(body.shippingAddress)).toEqual(ADDRESS_FIELDS);
      expect(body).toMatchObject({
        id: ord(order),
        customer: {
          id: `CUS-${customer.number}`,
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          phone: null,
        },
        itemCount: 4,
        // 3 x 19.99 + 39.95 = 99.92; + 4.99 - 1.00 + 5.10 = 109.01
        subtotal: 99.92,
        shipping: 4.99,
        discount: 1,
        tax: 5.1,
        total: 109.01,
      });
      expect(body.items).toEqual([
        expect.objectContaining({
          productId: `PRD-${mug.number}`,
          productName: 'Ceramic Mug',
          sku: 'MUG-1',
          quantity: 3,
          unitPrice: 19.99,
          total: 59.97,
        }),
        expect.objectContaining({
          productId: `PRD-${pan.number}`,
          productName: 'Skillet',
          quantity: 1,
          unitPrice: 39.95,
          total: 39.95,
        }),
      ]);
    });

    it('keeps the customer and the lines as they were when the order was placed', async () => {
      const mug = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        price: '12.00',
      });
      const { customer, order } = await placedOrder(
        { items: [{ product: mug, quantity: 2 }] },
        { name: 'Ada Lovelace', email: 'ada@example.com' },
      );

      await ctx.prisma.customer.update({
        where: { id: customer.id },
        data: { name: 'Ada King', email: 'ada.king@example.com' },
      });
      await ctx.prisma.product.update({
        where: { id: mug.id },
        data: { name: 'Stoneware Mug', price: '15.00', archivedAt: new Date() },
      });

      const body = (await get(`/orders/${ord(order)}`).expect(200))
        .body as OrderBody;
      expect(body.customer).toMatchObject({
        id: `CUS-${customer.number}`,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      expect(body.items?.[0]).toMatchObject({
        productName: 'Ceramic Mug',
        unitPrice: 12,
        total: 24,
      });
      expect(body.total).toBe(24);
    });

    it('lists the lines in the order they were placed in', async () => {
      const products = [];
      for (const name of ['Zebra', 'Apple', 'Mango']) {
        products.push(await createProduct(ctx.prisma, { name }));
      }
      const { order } = await placedOrder({
        items: products.map((product) => ({ product, quantity: 1 })),
      });
      const body = (await get(`/orders/${ord(order)}`).expect(200))
        .body as OrderBody;
      expect(body.items?.map((item) => item.productName)).toEqual([
        'Zebra',
        'Apple',
        'Mango',
      ]);
    });

    it('answers 404 for an unknown order', async () => {
      const res = await get('/orders/ORD-999999').expect(404);
      expect(res.body.message).toBe('Order not found');
    });

    it.each(['10001', 'CUS-1001', 'ORD-0', 'ORD-abc', 'ORD-2147483648'])(
      'answers 400 for the malformed id %s',
      async (id) => {
        await get(`/orders/${id}`).expect(400);
        await patch(`/orders/${id}/status`, { status: 'PROCESSING' }).expect(
          400,
        );
        await patch(`/orders/${id}/payment-status`, {
          paymentStatus: 'PAID',
        }).expect(400);
      },
    );
  });

  describe('PATCH /orders/:orderId/status', () => {
    const statusOf = async (order: { id: string }) =>
      ctx.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paymentStatus: true },
      });

    it('walks a paid order through to delivery, recording every step', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
        const res = await patch(`/orders/${ord(order)}/status`, {
          status,
        }).expect(200);
        expect(res.body).toMatchObject({ id: ord(order), status });
        expect(keysOf(res.body)).toEqual(DETAIL_FIELDS);
      }

      const events = await ctx.prisma.orderEvent.findMany({
        orderBy: { createdAt: 'asc' },
        include: { actor: true },
      });
      expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
        ['PENDING', 'PROCESSING'],
        ['PROCESSING', 'SHIPPED'],
        ['SHIPPED', 'DELIVERED'],
      ]);
      expect(new Set(events.map((e) => e.actor?.name))).toEqual(
        new Set(['Ada Admin']),
      );
      expect(new Set(events.map((e) => e.type))).toEqual(
        new Set(['STATUS_CHANGED']),
      );
    });

    it('lets an order skip processing and ship straight away', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      await patch(`/orders/${ord(order)}/status`, {
        status: 'SHIPPED',
      }).expect(200);
    });

    it('refuses to ship an order that has not been paid, and changes nothing', async () => {
      const { order } = await placedOrder({
        status: 'PROCESSING',
        paymentStatus: 'PENDING',
      });
      const res = await patch(`/orders/${ord(order)}/status`, {
        status: 'SHIPPED',
      }).expect(409);
      expect(res.body.message).toBe(
        'An order can only be marked as shipped once it has been paid.',
      );
      expect(await statusOf(order)).toEqual({
        status: 'PROCESSING',
        paymentStatus: 'PENDING',
      });
      expect(await ctx.prisma.orderEvent.count()).toBe(0);

      await patch(`/orders/${ord(order)}/payment-status`, {
        paymentStatus: 'PAID',
      }).expect(200);
      await patch(`/orders/${ord(order)}/status`, {
        status: 'SHIPPED',
      }).expect(200);
    });

    it.each([
      ['DELIVERED', 'SHIPPED', "A delivered order can't change status."],
      ['DELIVERED', 'CANCELLED', "A delivered order can't change status."],
      ['CANCELLED', 'PENDING', "A cancelled order can't change status."],
      ['CANCELLED', 'PROCESSING', "A cancelled order can't change status."],
      ['SHIPPED', 'CANCELLED', "A shipped order can't be cancelled."],
      [
        'SHIPPED',
        'PROCESSING',
        "An order can't go from shipped to processing.",
      ],
      [
        'PROCESSING',
        'PENDING',
        "An order can't go from processing to pending.",
      ],
      ['PENDING', 'DELIVERED', "An order can't go from pending to delivered."],
    ] as const)('refuses %s -> %s with "%s"', async (from, to, message) => {
      const { order } = await placedOrder({ status: from });
      const before = await statusOf(order);

      const res = await patch(`/orders/${ord(order)}/status`, {
        status: to,
      }).expect(409);

      expect(res.body.message).toBe(message);
      expect(await statusOf(order)).toEqual(before);
    });

    it('records the cancellation of a paid order as refunded', async () => {
      const { order } = await placedOrder({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
      });
      const res = await patch(`/orders/${ord(order)}/status`, {
        status: 'CANCELLED',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
      });

      const [event] = await ctx.prisma.orderEvent.findMany();
      expect(event).toMatchObject({
        type: 'STATUS_CHANGED',
        fromStatus: 'PROCESSING',
        toStatus: 'CANCELLED',
        fromPaymentStatus: 'PAID',
        toPaymentStatus: 'REFUNDED',
      });
    });

    it('leaves an unpaid order unpaid when it is cancelled', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });
      const res = await patch(`/orders/${ord(order)}/status`, {
        status: 'CANCELLED',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      });
    });

    it('acknowledges a request for the status the order already has, doing nothing', async () => {
      const { order } = await placedOrder({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
      });
      const first = await patch(`/orders/${ord(order)}/status`, {
        status: 'SHIPPED',
      }).expect(200);
      const again = await patch(`/orders/${ord(order)}/status`, {
        status: 'SHIPPED',
      }).expect(200);

      expect(again.body.status).toBe('SHIPPED');
      expect(again.body.updatedAt).toBe(first.body.updatedAt);
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
    });

    it('lets exactly one of several identical requests change the order', async () => {
      const { order } = await placedOrder({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          patch(`/orders/${ord(order)}/status`, { status: 'SHIPPED' }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
    });

    it('lets exactly one of two conflicting requests win', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      const results = await Promise.all([
        patch(`/orders/${ord(order)}/status`, { status: 'SHIPPED' }),
        patch(`/orders/${ord(order)}/status`, { status: 'CANCELLED' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

      const winner = results.find((r) => r.status === 200)!.body as OrderBody;
      const stored = await statusOf(order);
      expect(stored.status).toBe(winner.status);
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
    });

    it('answers 404 for an unknown order and 400 for a bad body', async () => {
      await patch('/orders/ORD-999999/status', {
        status: 'PROCESSING',
      }).expect(404);

      const { order } = await placedOrder({ status: 'PENDING' });
      for (const body of [
        {},
        { status: 'SENT' },
        { status: 'processing' },
        { status: 'PROCESSING', paymentStatus: 'PAID' },
        { status: null },
      ]) {
        await patch(`/orders/${ord(order)}/status`, body).expect(400);
      }
    });
  });

  describe('PATCH /orders/:orderId/payment-status', () => {
    it('records a payment and says who recorded it', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });
      const res = await patch(
        `/orders/${ord(order)}/payment-status`,
        { paymentStatus: 'PAID' },
        staffToken,
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PAID',
      });

      const [event] = await ctx.prisma.orderEvent.findMany({
        include: { actor: true },
      });
      expect(event).toMatchObject({
        type: 'PAYMENT_STATUS_CHANGED',
        fromPaymentStatus: 'PENDING',
        toPaymentStatus: 'PAID',
      });
      expect(event.actor?.name).toBe('Sam Staff');
    });

    it('is harmless to repeat', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          patch(`/orders/${ord(order)}/payment-status`, {
            paymentStatus: 'PAID',
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
    });

    it('refuses a cancelled order', async () => {
      const { order } = await placedOrder({
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      });
      const res = await patch(`/orders/${ord(order)}/payment-status`, {
        paymentStatus: 'PAID',
      }).expect(409);
      expect(res.body.message).toBe(
        "A cancelled order can't be marked as paid.",
      );
    });

    it('only ever records "paid"', async () => {
      const { order } = await placedOrder({
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      for (const paymentStatus of ['PENDING', 'REFUNDED', 'paid', null]) {
        await patch(`/orders/${ord(order)}/payment-status`, {
          paymentStatus,
        }).expect(400);
      }
    });

    it('answers 404 for an unknown order', async () => {
      await patch('/orders/ORD-999999/payment-status', {
        paymentStatus: 'PAID',
      }).expect(404);
    });
  });

  describe('what orders mean for customers', () => {
    it('stops counting a cancelled order towards what the customer spent', async () => {
      const customer = await createCustomer(ctx.prisma);
      await createOrder(ctx.prisma, customer, {
        total: 100,
        status: 'DELIVERED',
      });
      const open = await createOrder(ctx.prisma, customer, {
        total: 40,
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      const cus = `CUS-${customer.number}`;

      const before = (await get(`/customers/${cus}`).expect(200)).body as {
        customer: { totalOrders: number; totalSpent: number };
      };
      expect(before.customer).toMatchObject({
        totalOrders: 2,
        totalSpent: 140,
      });

      await patch(`/orders/${ord(open)}/status`, {
        status: 'CANCELLED',
      }).expect(200);

      const after = (await get(`/customers/${cus}`).expect(200)).body as {
        customer: { totalOrders: number; totalSpent: number };
        recentOrders: { id: string; status: string }[];
      };
      // Counted as an order, but no longer as money spent.
      expect(after.customer).toMatchObject({ totalOrders: 2, totalSpent: 100 });
      expect(after.recentOrders.find((o) => o.id === ord(open))?.status).toBe(
        'CANCELLED',
      );
    });
  });
});
