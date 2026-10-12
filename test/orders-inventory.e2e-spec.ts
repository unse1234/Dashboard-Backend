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

// Several of these fire many requests at once against a real database.
jest.setTimeout(60_000);

interface OrderBody {
  id: string;
  status: string;
  paymentStatus: string;
  itemCount: number;
  subtotal: number;
  shipping: number;
  discount: number;
  tax: number;
  total: number;
  customer: { id: string; name: string; email: string; phone: string | null };
  items: {
    productId: string;
    productName: string;
    sku: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
}

const prd = (product: { number: number }) => `PRD-${product.number}`;
const ord = (order: { number: number }) => `ORD-${order.number}`;

const ADDRESS = {
  recipientName: 'Ada Lovelace',
  phone: '+1 555 0100',
  addressLine1: '12 St James Square',
  addressLine2: 'Flat 3',
  city: 'London',
  region: null,
  postalCode: 'SW1Y 4JH',
  country: 'United Kingdom',
};

describe('Orders and stock (e2e)', () => {
  let ctx: TestContext;
  let adminToken: string;
  let staffToken: string;
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string) => http().get(path).set(bearer(adminToken));
  const patch = (path: string, body: object) =>
    http().patch(path).set(bearer(adminToken)).send(body);

  let keySeq = 0;
  const newKey = () => `test-key-${Date.now()}-${(keySeq += 1)}`;
  // A `null` key sends no Idempotency-Key header at all.
  const place = (
    body: object,
    key: string | null = newKey(),
    token = adminToken,
  ) => {
    const req = http().post('/orders').set(bearer(token));
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  const stockOf = async (product: { id: string }) =>
    (
      await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { stock: true },
      })
    ).stock;
  const versionOf = async (product: { id: string }) =>
    (
      await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
        select: { version: true },
      })
    ).version;

  beforeAll(async () => {
    ctx = await createTestApp();
    // Some tests fire many requests at once through one supertest server.
    ctx.app.getHttpServer().setMaxListeners(0);
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'admin@example.com',
      name: 'Ada Admin',
      role: 'ADMIN',
    });
    await createUser(ctx.prisma, { email: 'staff@example.com' });
    adminToken = (await login(ctx.app, 'admin@example.com')).accessToken;
    staffToken = (await login(ctx.app, 'staff@example.com')).accessToken;
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "Order", "CustomerAddress", "Customer", "Product"',
    );
  });

  const orderFor = (
    customer: { number: number },
    lines: { product: { number: number }; quantity: number }[],
    extra: Record<string, unknown> = {},
  ) => ({
    customerId: `CUS-${customer.number}`,
    items: lines.map(({ product, quantity }) => ({
      productId: prd(product),
      quantity,
    })),
    shippingAddress: ADDRESS,
    ...extra,
  });

  describe('POST /orders', () => {
    it('places an order: priced from the products, snapshotted, stock taken', async () => {
      const mug = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        sku: 'MUG-1',
        price: '19.99',
        stock: 10,
      });
      const pan = await createProduct(ctx.prisma, {
        name: 'Skillet',
        sku: 'PAN-1',
        price: '39.95',
        stock: 4,
      });
      const customer = await createCustomer(ctx.prisma, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+1 555 0100',
      });

      const res = await place(
        orderFor(
          customer,
          [
            { product: mug, quantity: 3 },
            { product: pan, quantity: 1 },
          ],
          { shipping: 4.99, discount: 1, tax: 5.1 },
        ),
      ).expect(201);
      const order = res.body as OrderBody;

      expect(order).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        itemCount: 4,
        subtotal: 99.92,
        shipping: 4.99,
        discount: 1,
        tax: 5.1,
        total: 109.01,
        customer: {
          id: `CUS-${customer.number}`,
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          phone: '+1 555 0100',
        },
        shippingAddress: ADDRESS,
        // Defaults to the shipping address.
        billingAddress: ADDRESS,
      });
      expect(order.id).toMatch(/^ORD-\d+$/);
      expect(order.items).toEqual([
        expect.objectContaining({
          productId: prd(mug),
          productName: 'Ceramic Mug',
          sku: 'MUG-1',
          quantity: 3,
          unitPrice: 19.99,
          total: 59.97,
        }),
        expect.objectContaining({
          productId: prd(pan),
          productName: 'Skillet',
          sku: 'PAN-1',
          quantity: 1,
          unitPrice: 39.95,
          total: 39.95,
        }),
      ]);

      expect(await stockOf(mug)).toBe(7);
      expect(await stockOf(pan)).toBe(3);
      // The same order is what the rest of the API now reads.
      const read = (await get(`/orders/${order.id}`).expect(200)).body;
      expect(read).toEqual(order);
    });

    it('records the stock change on each product, with the order and no author', async () => {
      const mug = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);

      const res = await place(
        orderFor(customer, [{ product: mug, quantity: 2 }]),
      ).expect(201);

      const [event] = await ctx.prisma.productEvent.findMany();
      expect(event).toMatchObject({
        productId: mug.id,
        type: 'STOCK_CHANGED',
        actorId: null,
      });
      expect(event.data).toEqual({
        from: 10,
        to: 8,
        reason: 'ORDER_PLACED',
        orderNumber: Number((res.body as OrderBody).id.slice(4)),
      });
      expect(await versionOf(mug)).toBe(2);

      const history = await get(`/products/${prd(mug)}/history`).expect(200);
      expect(history.body.data[0]).toMatchObject({
        change: `Stock reduced from 10 to 8 by order ${(res.body as OrderBody).id}`,
        actor: null,
      });
    });

    it('records who placed it', async () => {
      const mug = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      await place(orderFor(customer, [{ product: mug, quantity: 1 }])).expect(
        201,
      );

      const [event] = await ctx.prisma.orderEvent.findMany({
        include: { actor: true },
      });
      expect(event).toMatchObject({
        type: 'CREATED',
        toStatus: 'PENDING',
        toPaymentStatus: 'PENDING',
      });
      expect(event.actor?.name).toBe('Ada Admin');
    });

    it('keeps separate billing and shipping addresses, and an order that is already paid', async () => {
      const mug = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      const billing = { ...ADDRESS, recipientName: 'Accounts', city: 'Leeds' };

      const res = await place(
        orderFor(customer, [{ product: mug, quantity: 1 }], {
          billingAddress: billing,
          paymentStatus: 'PAID',
        }),
      ).expect(201);

      expect(res.body).toMatchObject({
        paymentStatus: 'PAID',
        billingAddress: billing,
        shippingAddress: ADDRESS,
      });
    });

    it('prices an order the same however it is arranged in cents', async () => {
      const cheap = await createProduct(ctx.prisma, {
        price: '0.10',
        stock: 100,
      });
      const customer = await createCustomer(ctx.prisma);

      const res = await place(
        orderFor(customer, [{ product: cheap, quantity: 3 }], { tax: 0.07 }),
      ).expect(201);

      // 3 x 0.10 is 0.30000000000000004 as doubles.
      expect(res.body).toMatchObject({ subtotal: 0.3, total: 0.37 });
      const stored = await ctx.prisma.order.findFirstOrThrow();
      expect(stored.subtotal.toFixed(2)).toBe('0.30');
      expect(stored.total.toFixed(2)).toBe('0.37');
    });

    it('does not let the request name a price', async () => {
      const mug = await createProduct(ctx.prisma, { price: '19.99' });
      const customer = await createCustomer(ctx.prisma);
      const body = orderFor(customer, [{ product: mug, quantity: 1 }]);
      body.items = [{ ...body.items[0], unitPrice: 0.01 } as never];

      await place(body).expect(400);
      expect(await ctx.prisma.order.count()).toBe(0);
      expect(await stockOf(mug)).toBe(10);
    });

    it('keeps an order reading the same when its products are edited or archived', async () => {
      const mug = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        sku: 'MUG-1',
        price: '12.00',
      });
      const customer = await createCustomer(ctx.prisma);
      const placed = (
        await place(orderFor(customer, [{ product: mug, quantity: 2 }])).expect(
          201,
        )
      ).body as OrderBody;

      await patch(`/products/${prd(mug)}`, {
        version: 2,
        name: 'Stoneware Mug',
        price: 15,
      }).expect(200);
      await http()
        .post('/products/archive')
        .set(bearer(adminToken))
        .send({ productIds: [prd(mug)] })
        .expect(200);

      const read = (await get(`/orders/${placed.id}`).expect(200))
        .body as OrderBody;
      expect(read.items[0]).toMatchObject({
        productName: 'Ceramic Mug',
        sku: 'MUG-1',
        unitPrice: 12,
        total: 24,
      });
      expect(read.total).toBe(24);
    });

    describe('what it refuses', () => {
      it('is for administrators', async () => {
        const mug = await createProduct(ctx.prisma);
        const customer = await createCustomer(ctx.prisma);
        await place(
          orderFor(customer, [{ product: mug, quantity: 1 }]),
          newKey(),
          staffToken,
        ).expect(403);
        expect(await stockOf(mug)).toBe(10);
      });

      it.each([
        ['no key', null],
        ['a short key', 'abc'],
        ['a key with spaces', 'not a valid key at all'],
        ['a key that is too long', 'k'.repeat(101)],
      ])('answers 400 for %s', async (_label, key) => {
        const mug = await createProduct(ctx.prisma);
        const customer = await createCustomer(ctx.prisma);
        const res = await place(
          orderFor(customer, [{ product: mug, quantity: 1 }]),
          key,
        ).expect(400);
        expect(res.body.message).toContain('Idempotency-Key');
        expect(await ctx.prisma.order.count()).toBe(0);
      });

      it('answers 404 for a customer that does not exist', async () => {
        const mug = await createProduct(ctx.prisma);
        const res = await place({
          customerId: 'CUS-999999',
          items: [{ productId: prd(mug), quantity: 1 }],
          shippingAddress: ADDRESS,
        }).expect(404);
        expect(res.body.message).toBe('Customer not found');
        expect(await stockOf(mug)).toBe(10);
      });

      it('answers 400 for a product that is unknown, switched off or archived', async () => {
        const customer = await createCustomer(ctx.prisma);
        const off = await createProduct(ctx.prisma, { status: 'INACTIVE' });
        const gone = await createProduct(ctx.prisma, { archived: true });
        const fine = await createProduct(ctx.prisma);

        for (const bad of [{ number: 999999 }, off, gone]) {
          const res = await place(
            orderFor(customer, [
              { product: fine, quantity: 1 },
              { product: bad, quantity: 1 },
            ]),
          ).expect(400);
          expect(res.body.message).toMatch(/Product PRD-\d+ is not available/);
        }
        // The available product was not touched by any of them.
        expect(await stockOf(fine)).toBe(10);
        expect(await ctx.prisma.order.count()).toBe(0);
      });

      it('answers 409 when there is not enough stock, and takes nothing', async () => {
        const plenty = await createProduct(ctx.prisma, { stock: 50 });
        const scarce = await createProduct(ctx.prisma, {
          sku: 'SCARCE-1',
          stock: 2,
        });
        const customer = await createCustomer(ctx.prisma);

        const res = await place(
          orderFor(customer, [
            { product: plenty, quantity: 5 },
            { product: scarce, quantity: 3 },
          ]),
        ).expect(409);

        expect(res.body.message).toBe(
          'Not enough stock for SCARCE-1 (2 available)',
        );
        // All or nothing: the line that had stock was not taken either.
        expect(await stockOf(plenty)).toBe(50);
        expect(await stockOf(scarce)).toBe(2);
        expect(await versionOf(plenty)).toBe(1);
        expect(await ctx.prisma.order.count()).toBe(0);
        expect(await ctx.prisma.productEvent.count()).toBe(0);
        expect(await ctx.prisma.orderEvent.count()).toBe(0);
      });

      it('can take the last unit, but not one more', async () => {
        const last = await createProduct(ctx.prisma, { stock: 2 });
        const customer = await createCustomer(ctx.prisma);

        await place(
          orderFor(customer, [{ product: last, quantity: 2 }]),
        ).expect(201);
        expect(await stockOf(last)).toBe(0);
        await place(
          orderFor(customer, [{ product: last, quantity: 1 }]),
        ).expect(409);
        expect(await stockOf(last)).toBe(0);
      });

      it('rolls back the stock when the discount is more than the order is worth', async () => {
        const mug = await createProduct(ctx.prisma, { price: '10.00' });
        const customer = await createCustomer(ctx.prisma);

        const res = await place(
          orderFor(customer, [{ product: mug, quantity: 1 }], {
            shipping: 5,
            tax: 1,
            discount: 16.01,
          }),
        ).expect(400);

        expect(res.body.message).toBe(
          "The discount can't be more than the order is worth",
        );
        expect(await stockOf(mug)).toBe(10);
        expect(await ctx.prisma.productEvent.count()).toBe(0);
      });

      it('accepts a discount up to everything the order is worth', async () => {
        const mug = await createProduct(ctx.prisma, { price: '10.00' });
        const customer = await createCustomer(ctx.prisma);

        const res = await place(
          orderFor(customer, [{ product: mug, quantity: 1 }], {
            shipping: 5,
            tax: 1,
            discount: 16,
          }),
        ).expect(201);
        expect(res.body.total).toBe(0);
      });

      it.each([
        ['no items', { items: [] }],
        ['a product twice', 'duplicate'],
        [
          'a quantity of 0',
          { items: [{ productId: 'PRD-1001', quantity: 0 }] },
        ],
        [
          'a quantity over 1000',
          { items: [{ productId: 'PRD-1001', quantity: 1001 }] },
        ],
        [
          'a fractional quantity',
          { items: [{ productId: 'PRD-1001', quantity: 1.5 }] },
        ],
        [
          'a malformed product id',
          { items: [{ productId: '1001', quantity: 1 }] },
        ],
        ['a malformed customer id', { customerId: 'ada@example.com' }],
        ['a negative shipping amount', { shipping: -1 }],
        ['a discount with three decimals', { discount: 0.005 }],
        ['an unknown payment status', { paymentStatus: 'REFUNDED' }],
        ['no shipping address', { shippingAddress: undefined }],
        [
          'an address without a city',
          { shippingAddress: { ...ADDRESS, city: '' } },
        ],
        ['a status', { status: 'SHIPPED' }],
        ['a total', { total: 1 }],
        ['an idempotency key in the body', { idempotencyKey: 'x'.repeat(12) }],
      ])('answers 400 for %s', async (_label, change) => {
        const mug = await createProduct(ctx.prisma);
        const customer = await createCustomer(ctx.prisma);
        let body: Record<string, unknown> = orderFor(customer, [
          { product: mug, quantity: 1 },
        ]);
        if (change === 'duplicate') {
          body.items = [
            { productId: prd(mug), quantity: 1 },
            { productId: prd(mug), quantity: 2 },
          ];
        } else {
          body = { ...body, ...(change as Record<string, unknown>) };
        }

        await place(body).expect(400);
        expect(await stockOf(mug)).toBe(10);
        expect(await ctx.prisma.order.count()).toBe(0);
      });
    });
  });

  describe('retrying safely', () => {
    it('returns the order that was already placed, without taking stock again', async () => {
      const mug = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);
      const key = newKey();
      const body = orderFor(customer, [{ product: mug, quantity: 3 }]);

      const first = await place(body, key).expect(201);
      const again = await place(body, key).expect(201);

      expect(again.body).toEqual(first.body);
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await stockOf(mug)).toBe(7);
      expect(await ctx.prisma.productEvent.count()).toBe(1);
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
    });

    it('treats the same lines in another order as the same request', async () => {
      const a = await createProduct(ctx.prisma);
      const b = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      const key = newKey();

      const first = await place(
        orderFor(customer, [
          { product: a, quantity: 1 },
          { product: b, quantity: 2 },
        ]),
        key,
      ).expect(201);
      const again = await place(
        orderFor(customer, [
          { product: b, quantity: 2 },
          { product: a, quantity: 1 },
        ]),
        key,
      ).expect(201);

      expect(again.body.id).toBe(first.body.id);
      expect(await ctx.prisma.order.count()).toBe(1);
    });

    it('refuses a key that was used for a different order', async () => {
      const mug = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      const key = newKey();

      await place(
        orderFor(customer, [{ product: mug, quantity: 1 }]),
        key,
      ).expect(201);
      const res = await place(
        orderFor(customer, [{ product: mug, quantity: 2 }]),
        key,
      ).expect(409);

      expect(res.body.message).toBe(
        'This Idempotency-Key was already used for a different order',
      );
      expect(await stockOf(mug)).toBe(9);
      expect(await ctx.prisma.order.count()).toBe(1);
    });

    it('places one order when the same request arrives many times at once', async () => {
      const mug = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);
      const key = newKey();
      const body = orderFor(customer, [{ product: mug, quantity: 4 }]);

      const results = await Promise.all(
        Array.from({ length: 8 }, () => place(body, key)),
      );

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(new Set(results.map((r) => (r.body as OrderBody).id)).size).toBe(
        1,
      );
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await stockOf(mug)).toBe(6);
    });

    it('answers a retry with the order even when the stock has since run out', async () => {
      const last = await createProduct(ctx.prisma, { stock: 1 });
      const customer = await createCustomer(ctx.prisma);
      const key = newKey();
      const body = orderFor(customer, [{ product: last, quantity: 1 }]);

      const first = await place(body, key).expect(201);
      expect(await stockOf(last)).toBe(0);
      const again = await place(body, key).expect(201);

      expect(again.body.id).toBe(first.body.id);
    });
  });

  describe('selling the last unit', () => {
    it('lets exactly one of many simultaneous orders take the last unit', async () => {
      const last = await createProduct(ctx.prisma, { stock: 1 });
      const customer = await createCustomer(ctx.prisma);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          place(orderFor(customer, [{ product: last, quantity: 1 }])),
        ),
      );

      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await stockOf(last)).toBe(0);
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await ctx.prisma.productEvent.count()).toBe(1);
    });

    it('sells exactly the stock there is, never more', async () => {
      const product = await createProduct(ctx.prisma, { stock: 5 });
      const customer = await createCustomer(ctx.prisma);

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          place(orderFor(customer, [{ product, quantity: 1 }])),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(await stockOf(product)).toBe(0);
      const units = await ctx.prisma.orderItem.aggregate({
        _sum: { quantity: true },
      });
      expect(units._sum.quantity).toBe(5);
    });

    it('serves every order when there is stock for all of them', async () => {
      const product = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          place(orderFor(customer, [{ product, quantity: 1 }])),
        ),
      );

      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect(await stockOf(product)).toBe(0);
      expect(await versionOf(product)).toBe(11);
    });

    it('does not deadlock when orders list the same products in opposite orders', async () => {
      const a = await createProduct(ctx.prisma, { stock: 20 });
      const b = await createProduct(ctx.prisma, { stock: 20 });
      const customer = await createCustomer(ctx.prisma);

      const results = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          place(
            orderFor(
              customer,
              i % 2 === 0
                ? [
                    { product: a, quantity: 1 },
                    { product: b, quantity: 1 },
                  ]
                : [
                    { product: b, quantity: 1 },
                    { product: a, quantity: 1 },
                  ],
            ),
          ),
        ),
      );

      expect(results.map((r) => r.status)).toEqual(Array(16).fill(201));
      expect(await stockOf(a)).toBe(4);
      expect(await stockOf(b)).toBe(4);
    });

    it('keeps each product consistent when orders compete for several', async () => {
      const a = await createProduct(ctx.prisma, { stock: 3 });
      const b = await createProduct(ctx.prisma, { stock: 5 });
      const customer = await createCustomer(ctx.prisma);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          place(
            orderFor(customer, [
              { product: a, quantity: 1 },
              { product: b, quantity: 1 },
            ]),
          ),
        ),
      );

      const placed = results.filter((r) => r.status === 201).length;
      // `a` runs out first, and a refused order took nothing from `b`.
      expect(placed).toBe(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(await stockOf(a)).toBe(0);
      expect(await stockOf(b)).toBe(2);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(
        true,
      );
    });

    it('keeps an edit made at the same time from losing what an order took', async () => {
      const product = await createProduct(ctx.prisma, { stock: 5 });
      const customer = await createCustomer(ctx.prisma);

      const [order, edit] = await Promise.all([
        place(orderFor(customer, [{ product, quantity: 2 }])),
        patch(`/products/${prd(product)}`, { version: 1, stock: 50 }),
      ]);

      expect(order.status).toBe(201);
      const stock = await stockOf(product);
      if (edit.status === 200) {
        // The edit went first: the order then took 2 from the edited 50.
        expect(stock).toBe(48);
      } else {
        // The order went first and the stale edit was refused.
        expect(edit.status).toBe(409);
        expect(stock).toBe(3);
      }
    });
  });

  describe('cancelling', () => {
    async function placeOne(quantity = 3, stock = 10) {
      const product = await createProduct(ctx.prisma, { stock });
      const customer = await createCustomer(ctx.prisma);
      const order = (
        await place(orderFor(customer, [{ product, quantity }])).expect(201)
      ).body as OrderBody;
      return { product, customer, order };
    }

    it('puts the stock back', async () => {
      const { product, order } = await placeOne(3, 10);
      expect(await stockOf(product)).toBe(7);

      const res = await patch(`/orders/${order.id}/status`, {
        status: 'CANCELLED',
      }).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(await stockOf(product)).toBe(10);
      expect(await versionOf(product)).toBe(3);
    });

    it("records the return on the product's history", async () => {
      const { product, order } = await placeOne(3, 10);
      await patch(`/orders/${order.id}/status`, { status: 'CANCELLED' }).expect(
        200,
      );

      const history = await get(`/products/${prd(product)}/history`).expect(
        200,
      );
      const changes = (history.body.data as { change: string }[]).map(
        (e) => e.change,
      );
      expect(changes).toContain(
        `Stock restored from 7 to 10 (order ${order.id} cancelled)`,
      );
      expect(changes).toContain(
        `Stock reduced from 10 to 7 by order ${order.id}`,
      );
    });

    it('puts the stock back once, however many times and however fast it is asked', async () => {
      const { product, order } = await placeOne(3, 10);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          patch(`/orders/${order.id}/status`, { status: 'CANCELLED' }),
        ),
      );
      await patch(`/orders/${order.id}/status`, { status: 'CANCELLED' }).expect(
        200,
      );

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await stockOf(product)).toBe(10);
      const returns = await ctx.prisma.productEvent.findMany({
        where: { productId: product.id },
      });
      expect(
        returns.filter(
          (e) => (e.data as { reason?: string }).reason === 'ORDER_CANCELLED',
        ),
      ).toHaveLength(1);
    });

    it('puts every line back, and only that order', async () => {
      const a = await createProduct(ctx.prisma, { stock: 10 });
      const b = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);
      const first = (
        await place(
          orderFor(customer, [
            { product: a, quantity: 2 },
            { product: b, quantity: 4 },
          ]),
        ).expect(201)
      ).body as OrderBody;
      await place(orderFor(customer, [{ product: a, quantity: 5 }])).expect(
        201,
      );
      expect([await stockOf(a), await stockOf(b)]).toEqual([3, 6]);

      await patch(`/orders/${first.id}/status`, { status: 'CANCELLED' }).expect(
        200,
      );

      // The second order (5 of a) still holds its stock.
      expect([await stockOf(a), await stockOf(b)]).toEqual([5, 10]);
    });

    it('puts stock back on a product that has been archived or switched off since', async () => {
      const { product, order } = await placeOne(3, 10);
      await http()
        .post('/products/archive')
        .set(bearer(adminToken))
        .send({ productIds: [prd(product)] })
        .expect(200);

      await patch(`/orders/${order.id}/status`, { status: 'CANCELLED' }).expect(
        200,
      );

      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.stock).toBe(10);
      expect(stored.archivedAt).not.toBeNull();
    });

    it('makes the units available to the next order', async () => {
      const { product, order, customer } = await placeOne(2, 2);
      await place(orderFor(customer, [{ product, quantity: 1 }])).expect(409);

      await patch(`/orders/${order.id}/status`, { status: 'CANCELLED' }).expect(
        200,
      );

      await place(orderFor(customer, [{ product, quantity: 2 }])).expect(201);
      expect(await stockOf(product)).toBe(0);
    });

    it('leaves other products alone when a line has no catalogue product', async () => {
      const product = await createProduct(ctx.prisma, { stock: 10 });
      const customer = await createCustomer(ctx.prisma);
      // An order recorded before products existed: its line has no product.
      const legacy = await createOrder(ctx.prisma, customer, {
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });

      await patch(`/orders/${ord(legacy)}/status`, {
        status: 'CANCELLED',
      }).expect(200);

      expect(await stockOf(product)).toBe(10);
      expect(await ctx.prisma.productEvent.count()).toBe(0);
    });

    it('does not put stock back when a cancellation is refused', async () => {
      const { product, order } = await placeOne(3, 10);
      await patch(`/orders/${order.id}/payment-status`, {
        paymentStatus: 'PAID',
      }).expect(200);
      await patch(`/orders/${order.id}/status`, { status: 'SHIPPED' }).expect(
        200,
      );

      await patch(`/orders/${order.id}/status`, {
        status: 'CANCELLED',
      }).expect(409);

      expect(await stockOf(product)).toBe(7);
    });

    it('does not move stock when an order is processed, shipped or delivered', async () => {
      const { product, order } = await placeOne(3, 10);
      await patch(`/orders/${order.id}/payment-status`, {
        paymentStatus: 'PAID',
      }).expect(200);

      for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
        await patch(`/orders/${order.id}/status`, { status }).expect(200);
        expect(await stockOf(product)).toBe(7);
      }
    });

    it('refunds a paid order when it is cancelled, and gives its stock back too', async () => {
      const mug = await createProduct(ctx.prisma, { stock: 4 });
      const customer = await createCustomer(ctx.prisma);
      const paid = (
        await place(
          orderFor(customer, [{ product: mug, quantity: 4 }], {
            paymentStatus: 'PAID',
          }),
        ).expect(201)
      ).body as OrderBody;
      expect(await stockOf(mug)).toBe(0);

      const res = await patch(`/orders/${paid.id}/status`, {
        status: 'CANCELLED',
      }).expect(200);

      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
      });
      expect(await stockOf(mug)).toBe(4);
    });
  });
});
