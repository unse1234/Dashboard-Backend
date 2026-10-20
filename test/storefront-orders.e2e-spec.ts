import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Prisma } from '../src/generated/prisma/client';
import { buildQuoteClaims } from '../src/orders/storefront/quote-claims';
import { DEMO_CHARGES } from '../src/orders/storefront/quote-claims';
import { QuoteTokenService } from '../src/orders/storefront/quote-token.service';
import {
  bearer,
  createCustomer,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  type ProductOptions,
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
const CONTACT = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  phone: '0300 1234567',
};
const RECEIPT_FIELDS = [
  'createdAt',
  'currency',
  'discount',
  'id',
  'items',
  'paymentMethod',
  'paymentStatus',
  'shipping',
  'status',
  'subtotal',
  'tax',
  'total',
];

interface Receipt {
  id: string;
  createdAt: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  currency: string;
  items: {
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
}

const prd = (product: { number: number }) => `PRD-${product.number}`;
const line = (product: { number: number }, quantity: number) => ({
  productId: prd(product),
  quantity,
});

describe('Storefront order placement (e2e)', () => {
  let ctx: TestContext;
  let adminToken: string;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'admin@example.com',
      role: 'ADMIN',
    });
    adminToken = (await login(ctx.app, 'admin@example.com')).accessToken;
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "EmailJob", "StorefrontToken", "Order", "CustomerAddress", "Customer", "Product"',
    );
  });

  /** A product the storefront shows, unless the options say otherwise. */
  const listed = (options: ProductOptions = {}) =>
    createProduct(ctx.prisma, {
      currency: 'PKR',
      price: '1500.00',
      stock: 10,
      ...options,
    });

  const quote = async (
    items: { productId: string; quantity: number }[],
    address: object = ADDRESS,
  ) => {
    const res = await http()
      .post('/storefront/checkout/quote')
      .send({ items, shippingAddress: address })
      .expect(200);
    return (res.body as { quoteToken: string }).quoteToken;
  };

  const place = (key: string | undefined, body: object): request.Test => {
    const req = http().post('/storefront/orders');
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(
      body,
    );
  };

  /** A complete, valid order body for these lines, quoted just now. */
  const orderFor = async (
    items: { productId: string; quantity: number }[],
    overrides: Partial<{
      contact: object;
      shippingAddress: object;
      quoteToken: string;
    }> = {},
  ) => ({
    contact: CONTACT,
    items,
    shippingAddress: ADDRESS,
    quoteToken: await quote(items, overrides.shippingAddress ?? ADDRESS),
    ...overrides,
  });

  const stockOf = async (product: { id: string }) =>
    (await ctx.prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
      .stock;

  const nothingWasWritten = async () => {
    expect(await ctx.prisma.order.count()).toBe(0);
    expect(await ctx.prisma.customer.count()).toBe(0);
    expect(await ctx.prisma.orderEvent.count()).toBe(0);
    expect(await ctx.prisma.orderItem.count()).toBe(0);
    expect(await ctx.prisma.productEvent.count()).toBe(0);
  };

  describe('placing an order', () => {
    it('places a COD order for an anonymous visitor and answers with a receipt', async () => {
      const kettle = await listed({ name: 'Kettle', price: '199.99' });
      const mug = await listed({ name: 'Mug', price: '0.10', stock: 4 });
      const items = [line(kettle, 3), line(mug, 2)];

      const res = await place(randomUUID(), await orderFor(items)).expect(201);
      const receipt = res.body as Receipt;

      expect(receipt).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
        currency: 'PKR',
        subtotal: 600.17,
        shipping: 0,
        tax: 0,
        discount: 0,
        total: 600.17,
      });
      expect(receipt.id).toMatch(/^ORD-\d+$/);
      expect(receipt.items).toEqual([
        {
          productId: prd(kettle),
          productName: 'Kettle',
          quantity: 3,
          unitPrice: 199.99,
          total: 599.97,
        },
        {
          productId: prd(mug),
          productName: 'Mug',
          quantity: 2,
          unitPrice: 0.1,
          total: 0.2,
        },
      ]);

      // The server took the stock.
      expect(await stockOf(kettle)).toBe(7);
      expect(await stockOf(mug)).toBe(2);
    });

    it('refuses a checkout quote for a legacy USD product without changing stock', async () => {
      const gadget = await listed({ currency: 'USD', price: '10.00' });
      const items = [line(gadget, 2)];
      const res = await http()
        .post('/storefront/checkout/quote')
        .send({ items, shippingAddress: ADDRESS })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
      });
      expect(res.body.quoteToken).toBeUndefined();
      expect(await stockOf(gadget)).toBe(gadget.stock);
      expect(await ctx.prisma.order.count()).toBe(0);
    });

    it('records the order as COD, PKR and pending, with snapshots and no actor', async () => {
      const kettle = await listed();
      const items = [line(kettle, 2)];
      const body = await orderFor(items);
      const res = await place('guest-key-0001', body).expect(201);
      const { id } = res.body as Receipt;

      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { number: Number(id.slice(4)) },
        include: { items: true, events: true, customer: true },
      });
      expect(order).toMatchObject({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
        currency: 'PKR',
        customerName: 'Ayesha Khan',
        customerEmail: 'ayesha@example.com',
        customerPhone: '0300 1234567',
        itemCount: 2,
        idempotencyKey: 'sf:guest-key-0001',
      });
      expect(Number(order.shipping)).toBe(0);
      expect(Number(order.tax)).toBe(0);
      expect(Number(order.discount)).toBe(0);
      expect(Number(order.total)).toBe(3000);
      expect(order.shippingAddress).toEqual({
        recipientName: 'Ayesha Khan',
        phone: '0300 1234567',
        addressLine1: 'House 12, Street 4, F-7/2',
        addressLine2: null,
        city: 'Islamabad',
        region: 'Islamabad Capital Territory',
        postalCode: '44000',
        country: 'PK',
      });
      // The delivery address is the billing address in V1.
      expect(order.billingAddress).toEqual(order.shippingAddress);

      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({
        productId: prd(kettle),
        productName: kettle.name,
        sku: kettle.sku,
        quantity: 2,
        catalogProductId: kettle.id,
      });
      // A guest is nobody who signed in.
      expect(order.events).toHaveLength(1);
      expect(order.events[0]).toMatchObject({
        type: 'CREATED',
        toStatus: 'PENDING',
        toPaymentStatus: 'PENDING',
        actorId: null,
      });
      const stockEvents = await ctx.prisma.productEvent.findMany({
        where: { productId: kettle.id },
      });
      expect(stockEvents).toHaveLength(1);
      expect(order.customer.email).toBe('ayesha@example.com');
    });

    it('shows the order and the new customer to staff, and nothing of staff to the guest', async () => {
      const kettle = await listed();
      const res = await place(
        randomUUID(),
        await orderFor([line(kettle, 1)]),
      ).expect(201);
      const receipt = res.body as Receipt;

      const adminOrder = await http()
        .get(`/orders/${receipt.id}`)
        .set(bearer(adminToken))
        .expect(200);
      expect(adminOrder.body).toMatchObject({
        id: receipt.id,
        paymentMethod: 'COD',
        currency: 'PKR',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        total: 1500,
        customer: { name: 'Ayesha Khan', email: 'ayesha@example.com' },
      });

      const customers = await http()
        .get('/customers')
        .query({ search: 'ayesha@example.com' })
        .set(bearer(adminToken))
        .expect(200);
      expect((customers.body as { data: unknown[] }).data).toHaveLength(1);
    });

    it('answers with exactly the receipt fields: no customer, internal id, key, hash or SKU', async () => {
      const kettle = await listed({ sku: 'HIDDEN-SKU-1' });
      const res = await place(
        'guest-key-0002',
        await orderFor([line(kettle, 1)]),
      ).expect(201);

      expect(Object.keys(res.body as object).sort()).toEqual(RECEIPT_FIELDS);
      const raw = JSON.stringify(res.body);
      const order = await ctx.prisma.order.findFirstOrThrow({
        include: { customer: true },
      });
      for (const hidden of [
        order.id,
        order.customer.id,
        order.customerEmail,
        order.customerName,
        'HIDDEN-SKU-1',
        'guest-key-0002',
        'requestHash',
        'idempotency',
        'customer',
        kettle.id,
      ]) {
        expect(raw).not.toContain(hidden);
      }
    });

    it('allows the Idempotency-Key header in a browser preflight', async () => {
      const res = await http()
        .options('/storefront/orders')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,idempotency-key')
        .expect(204);
      expect(
        String(res.headers['access-control-allow-headers']).toLowerCase(),
      ).toContain('idempotency-key');
    });
  });

  describe('the customer', () => {
    it('creates one for a new email, with the submitted name, email and phone', async () => {
      const kettle = await listed();
      await place(
        randomUUID(),
        await orderFor([line(kettle, 1)], {
          contact: {
            name: '  Ayesha Khan ',
            email: ' Ayesha@Example.COM ',
            phone: '+92 300 1234567',
          },
        }),
      ).expect(201);

      const customers = await ctx.prisma.customer.findMany();
      expect(customers).toHaveLength(1);
      expect(customers[0]).toMatchObject({
        name: 'Ayesha Khan',
        email: 'ayesha@example.com',
        phone: '+92 300 1234567',
      });
      expect(await ctx.prisma.customerAddress.count()).toBe(0);
    });

    it('reuses a customer by email, keeps their profile, and snapshots what was submitted', async () => {
      const existing = await createCustomer(ctx.prisma, {
        name: 'Ayesha K.',
        email: 'ayesha@example.com',
        phone: null,
      });
      const kettle = await listed();

      const res = await place(
        randomUUID(),
        await orderFor([line(kettle, 1)], {
          contact: { ...CONTACT, name: 'A. Khan', phone: '0321 7654321' },
        }),
      ).expect(201);

      expect(await ctx.prisma.customer.count()).toBe(1);
      const customer = await ctx.prisma.customer.findUniqueOrThrow({
        where: { id: existing.id },
      });
      // Not overwritten...
      expect(customer).toMatchObject({ name: 'Ayesha K.', phone: null });
      // ...while the order keeps what this purchase said.
      const order = await ctx.prisma.order.findFirstOrThrow({
        where: { customerId: existing.id },
      });
      expect(order).toMatchObject({
        customerName: 'A. Khan',
        customerPhone: '0321 7654321',
        customerEmail: 'ayesha@example.com',
      });
      // And the guest is told nothing about the customer they matched.
      expect(JSON.stringify(res.body)).not.toContain('Ayesha K.');
    });

    it('matches an email across case, including a customer stored before emails were lower-cased', async () => {
      const legacy = await createCustomer(ctx.prisma, {
        name: 'Legacy',
        email: 'Mixed.Case@Example.com',
      });
      const kettle = await listed();

      await place(
        randomUUID(),
        await orderFor([line(kettle, 1)], {
          contact: { ...CONTACT, email: 'MIXED.case@example.COM' },
        }),
      ).expect(201);

      expect(await ctx.prisma.customer.count()).toBe(1);
      expect(
        await ctx.prisma.order.count({ where: { customerId: legacy.id } }),
      ).toBe(1);
    });

    it('does not match by name or phone alone', async () => {
      await createCustomer(ctx.prisma, {
        name: 'Ayesha Khan',
        email: 'someone.else@example.com',
        phone: '0300 1234567',
      });
      const kettle = await listed();
      await place(randomUUID(), await orderFor([line(kettle, 1)])).expect(201);
      expect(await ctx.prisma.customer.count()).toBe(2);
    });

    it('creates one customer when first purchases with one email race', async () => {
      const kettle = await listed({ stock: 20 });
      const items = [line(kettle, 1)];
      const bodies = await Promise.all(
        Array.from({ length: 5 }, () => orderFor(items)),
      );

      const results = await Promise.all(
        bodies.map((body) => place(randomUUID(), body)),
      );

      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(await ctx.prisma.customer.count()).toBe(1);
      expect(await ctx.prisma.order.count()).toBe(5);
      expect(await stockOf(kettle)).toBe(15);
    });
  });

  describe('stock', () => {
    it('lets exactly one of two guests have the last unit', async () => {
      const last = await listed({ stock: 1 });
      const items = [line(last, 1)];
      const a = await orderFor(items, {
        contact: { ...CONTACT, email: 'a@example.com' },
      });
      const b = await orderFor(items, {
        contact: { ...CONTACT, email: 'b@example.com' },
      });

      const [first, second] = await Promise.all([
        place(randomUUID(), a),
        place(randomUUID(), b),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body).toMatchObject({
        statusCode: 409,
        code: 'INSUFFICIENT_STOCK',
        productId: prd(last),
      });
      // It does not say how many there are, or which SKU.
      expect(JSON.stringify(loser.body)).not.toMatch(/available|left|SKU-/);

      expect(await stockOf(last)).toBe(0);
      expect(await ctx.prisma.order.count()).toBe(1);
      // The loser's customer was rolled back with its order.
      expect(await ctx.prisma.customer.count()).toBe(1);
    });

    it('rolls back everything when a later line cannot be filled', async () => {
      const plenty = await listed({ name: 'Plenty', stock: 10 });
      const scarce = await listed({ name: 'Scarce', stock: 5 });
      const items = [line(plenty, 3), line(scarce, 2)];
      const body = await orderFor(items);

      // Someone else buys most of it between the review and the order.
      await ctx.prisma.product.update({
        where: { id: scarce.id },
        data: { stock: 1 },
      });

      const res = await place(randomUUID(), body).expect(409);
      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        productId: prd(scarce),
      });

      expect(await stockOf(plenty)).toBe(10);
      expect(await stockOf(scarce)).toBe(1);
      await nothingWasWritten();
    });

    it('refuses a product that was switched off after the quote, saying so by id', async () => {
      const kettle = await listed();
      const mug = await listed();
      const body = await orderFor([line(kettle, 1), line(mug, 1)]);
      await ctx.prisma.product.update({
        where: { id: mug.id },
        data: { status: 'INACTIVE' },
      });

      const res = await place(randomUUID(), body).expect(409);
      expect(res.body).toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
        productId: prd(mug),
      });
      expect(await stockOf(kettle)).toBe(10);
      await nothingWasWritten();
    });

    it('refuses a product whose currency changed after the quote', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      await ctx.prisma.product.update({
        where: { id: kettle.id },
        data: { currency: 'USD' },
      });

      const res = await place(randomUUID(), body).expect(409);
      expect(res.body).toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
      expect(await stockOf(kettle)).toBe(10);
      await nothingWasWritten();
    });
  });

  describe('the quote', () => {
    it('holds the order to the price the guest reviewed', async () => {
      const kettle = await listed({ price: '1500.00' });
      const body = await orderFor([line(kettle, 1)]);
      await ctx.prisma.product.update({
        where: { id: kettle.id },
        data: { price: '1600.00' },
      });

      const res = await place(randomUUID(), body).expect(409);
      expect(res.body).toMatchObject({
        code: 'QUOTE_CHANGED',
        reason: 'PRICES_CHANGED',
      });
      expect(await stockOf(kettle)).toBe(10);
      await nothingWasWritten();
    });

    it('refuses a token it did not issue', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      for (const quoteToken of [
        'not-a-token',
        `${body.quoteToken.slice(0, -2)}xx`,
        `${body.quoteToken}.extra`,
      ]) {
        const res = await place(randomUUID(), { ...body, quoteToken }).expect(
          409,
        );
        expect(res.body).toMatchObject({
          code: 'QUOTE_CHANGED',
          reason: 'TOKEN_INVALID',
        });
      }
      await nothingWasWritten();
    });

    it('refuses an expired quote', async () => {
      const kettle = await listed();
      const claims = buildQuoteClaims(
        'PKR',
        [
          {
            number: kettle.number,
            quantity: 1,
            unitPrice: new Prisma.Decimal('1500.00'),
          },
        ],
        {
          subtotal: new Prisma.Decimal('1500.00'),
          total: new Prisma.Decimal('1500.00'),
        },
        DEMO_CHARGES,
        { region: ADDRESS.region },
      );
      const { token } = ctx.app
        .get(QuoteTokenService)
        .issue(claims, new Date(Date.now() - 24 * 60 * 60 * 1000));

      const res = await place(randomUUID(), {
        contact: CONTACT,
        items: [line(kettle, 1)],
        shippingAddress: ADDRESS,
        quoteToken: token,
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'QUOTE_CHANGED',
        reason: 'QUOTE_EXPIRED',
      });
      await nothingWasWritten();
    });

    it('refuses a bag or a province that is not the one quoted', async () => {
      const kettle = await listed();
      const mug = await listed();
      const body = await orderFor([line(kettle, 1)]);

      const moreOfIt = await place(randomUUID(), {
        ...body,
        items: [line(kettle, 2)],
      }).expect(409);
      expect(moreOfIt.body).toMatchObject({ reason: 'ITEMS_CHANGED' });

      const another = await place(randomUUID(), {
        ...body,
        items: [line(kettle, 1), line(mug, 1)],
      }).expect(409);
      expect(another.body).toMatchObject({ reason: 'ITEMS_CHANGED' });

      const elsewhere = await place(randomUUID(), {
        ...body,
        shippingAddress: { ...ADDRESS, region: 'Sindh' },
      }).expect(409);
      expect(elsewhere.body).toMatchObject({
        code: 'QUOTE_CHANGED',
        reason: 'DESTINATION_CHANGED',
      });
      await nothingWasWritten();
    });

    it('accepts the quoted bag listed in another order and the province in another case', async () => {
      const kettle = await listed();
      const mug = await listed();
      const body = await orderFor([line(kettle, 1), line(mug, 2)]);

      await place(randomUUID(), {
        ...body,
        items: [line(mug, 2), line(kettle, 1)],
        shippingAddress: {
          ...ADDRESS,
          region: ' islamabad  capital TERRITORY',
        },
      }).expect(201);
    });
  });

  describe('retries', () => {
    it('returns the same order for a retry, without a second deduction', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 2)]);
      const key = randomUUID();

      const first = await place(key, body).expect(201);
      const again = await place(key, body).expect(201);

      expect(again.body).toEqual(first.body);
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await ctx.prisma.orderEvent.count()).toBe(1);
      expect(await stockOf(kettle)).toBe(8);
    });

    it('treats identical requests that race as one order', async () => {
      const kettle = await listed({ stock: 10 });
      const body = await orderFor([line(kettle, 3)]);
      const key = randomUUID();

      const results = await Promise.all(
        Array.from({ length: 6 }, () => place(key, body)),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      const ids = new Set(results.map((r) => (r.body as Receipt).id));
      expect(ids.size).toBe(1);
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await ctx.prisma.customer.count()).toBe(1);
      expect(await stockOf(kettle)).toBe(7);
    });

    it('answers a retry with the original order after the price and the stock have moved', async () => {
      const kettle = await listed({ price: '1500.00', stock: 3 });
      const body = await orderFor([line(kettle, 3)]);
      const key = randomUUID();
      const first = await place(key, body).expect(201);

      // Sold out, repriced and switched off since.
      await ctx.prisma.product.update({
        where: { id: kettle.id },
        data: { price: '9999.00', status: 'INACTIVE' },
      });

      const again = await place(key, body).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await stockOf(kettle)).toBe(0);
    });

    it('answers a retry with the original order after the quote has expired, before looking at the quote', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      const key = randomUUID();
      const first = await place(key, body).expect(201);

      const verify = jest
        .spyOn(QuoteTokenService.prototype, 'verify')
        .mockReturnValue({ status: 'invalid' });

      const again = await place(key, body).expect(201);
      expect(again.body).toEqual(first.body);
      expect(verify).not.toHaveBeenCalled();
    });

    it('refuses the same key for a different order', async () => {
      const kettle = await listed();
      const key = randomUUID();
      const items = [line(kettle, 1)];
      const body = await orderFor(items);
      await place(key, body).expect(201);

      const otherQuantity = await place(
        key,
        await orderFor([line(kettle, 2)]),
      ).expect(409);
      expect(otherQuantity.body).toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });

      const otherBuyer = await place(key, {
        ...body,
        contact: { ...CONTACT, email: 'someone.else@example.com' },
      }).expect(409);
      expect(otherBuyer.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      // A renewed quote is a different request, even for the same bag. (Tokens
      // are issued to the second, so this one is issued a minute on to differ.)
      const claims = buildQuoteClaims(
        'PKR',
        [
          {
            number: kettle.number,
            quantity: 1,
            unitPrice: new Prisma.Decimal('1500.00'),
          },
        ],
        {
          subtotal: new Prisma.Decimal('1500.00'),
          total: new Prisma.Decimal('1500.00'),
        },
        DEMO_CHARGES,
        { region: ADDRESS.region },
      );
      const { token } = ctx.app
        .get(QuoteTokenService)
        .issue(claims, new Date(Date.now() + 60_000));
      expect(token).not.toBe(body.quoteToken);
      const renewed = await place(key, { ...body, quoteToken: token }).expect(
        409,
      );
      expect(renewed.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      expect(await ctx.prisma.order.count()).toBe(1);
      expect(await stockOf(kettle)).toBe(9);
    });

    it('keeps a guest key apart from a dashboard key that reads the same', async () => {
      const kettle = await listed();
      const customer = await createCustomer(ctx.prisma);
      const key = 'shared-key-0001';

      await http()
        .post('/orders')
        .set(bearer(adminToken))
        .set('Idempotency-Key', key)
        .send({
          customerId: `CUS-${customer.number}`,
          items: [line(kettle, 1)],
          shippingAddress: {
            recipientName: 'Test',
            addressLine1: '1 Street',
            city: 'Lahore',
            country: 'PK',
          },
        })
        .expect(201);

      // Neither replays the other: the guest's is a second, separate order.
      await place(key, await orderFor([line(kettle, 1)])).expect(201);
      expect(await ctx.prisma.order.count()).toBe(2);
      expect(await stockOf(kettle)).toBe(8);
    });
  });

  describe('invalid requests', () => {
    it('needs an Idempotency-Key of a sensible shape', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      for (const key of [
        undefined,
        'short',
        'has spaces in it',
        'x'.repeat(101),
        'sf:abcdefgh',
      ]) {
        const res = await place(key, body).expect(400);
        expect(JSON.stringify(res.body)).toContain('Idempotency-Key');
      }
      await nothingWasWritten();
    });

    it.each([
      ['a customer id', { customerId: 'CUS-1001' }],
      ['an amount', { total: 1 }],
      ['a shipping charge', { shipping: 0 }],
      ['a status', { status: 'DELIVERED' }],
      ['a payment status', { paymentStatus: 'PAID' }],
      ['a currency', { currency: 'USD' }],
      ['card details', { card: { number: '4242424242424242' } }],
      ['a billing address', { billingAddress: ADDRESS }],
    ])('refuses %s from the client', async (_name, extra) => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      await place(randomUUID(), { ...body, ...extra }).expect(400);
      expect(await stockOf(kettle)).toBe(10);
      await nothingWasWritten();
    });

    it('refuses a delivery outside Pakistan', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      const res = await place(randomUUID(), {
        ...body,
        shippingAddress: { ...ADDRESS, country: 'US' },
      }).expect(400);
      expect(res.body).toMatchObject({ code: 'UNSUPPORTED_DESTINATION' });
      await nothingWasWritten();
    });

    it('needs a Pakistani contact phone and a valid email', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      for (const contact of [
        { ...CONTACT, phone: '+1 202 555 0147' },
        { ...CONTACT, phone: undefined },
        { ...CONTACT, email: 'not-an-email' },
        { ...CONTACT, email: undefined },
        { ...CONTACT, name: '   ' },
      ]) {
        await place(randomUUID(), { ...body, contact }).expect(400);
      }
      await nothingWasWritten();
    });

    it('refuses an empty bag, and a product listed twice', async () => {
      const kettle = await listed();
      const body = await orderFor([line(kettle, 1)]);
      await place(randomUUID(), { ...body, items: [] }).expect(400);

      const twice = await place(randomUUID(), {
        ...body,
        items: [
          line(kettle, 1),
          { productId: prd(kettle).toLowerCase(), quantity: 1 },
        ],
      }).expect(400);
      expect(twice.body).toMatchObject({ code: 'INVALID_BAG' });
      await nothingWasWritten();
    });

    it('does not sell a product the storefront does not show, even with a valid quote for it', async () => {
      // Quotes refuse such a product, so sign one by hand: the order itself
      // must still hold the line.
      const dollars = await createProduct(ctx.prisma, {
        currency: 'PKR',
        price: '10.00',
        status: 'INACTIVE',
      });
      const claims = buildQuoteClaims(
        'PKR',
        [
          {
            number: dollars.number,
            quantity: 1,
            unitPrice: new Prisma.Decimal('10.00'),
          },
        ],
        {
          subtotal: new Prisma.Decimal('10.00'),
          total: new Prisma.Decimal('10.00'),
        },
        DEMO_CHARGES,
        { region: ADDRESS.region },
      );
      const { token } = ctx.app.get(QuoteTokenService).issue(claims);

      const res = await place(randomUUID(), {
        contact: CONTACT,
        items: [line(dollars, 1)],
        shippingAddress: ADDRESS,
        quoteToken: token,
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
        productId: prd(dollars),
      });
      expect(await stockOf(dollars)).toBe(10);
      await nothingWasWritten();
    });
  });

  describe('the dashboard still works on these orders', () => {
    it('lets staff ship a guest order unpaid, record the cash, and deliver it', async () => {
      const kettle = await listed({ stock: 5 });
      const res = await place(
        randomUUID(),
        await orderFor([line(kettle, 1)]),
      ).expect(201);
      const { id } = res.body as Receipt;
      const status = (value: string) =>
        http()
          .patch(`/orders/${id}/status`)
          .set(bearer(adminToken))
          .send({ status: value });

      const shipped = await status('SHIPPED').expect(200);
      expect(shipped.body).toMatchObject({
        status: 'SHIPPED',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
      });
      await status('DELIVERED').expect(409);

      await http()
        .patch(`/orders/${id}/payment-status`)
        .set(bearer(adminToken))
        .send({ paymentStatus: 'PAID' })
        .expect(200);
      const delivered = await status('DELIVERED').expect(200);
      expect(delivered.body).toMatchObject({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
      });
      // The unit stays sold.
      expect(await stockOf(kettle)).toBe(4);
    });

    it('lets staff cancel a guest order, which puts its stock back once', async () => {
      const kettle = await listed({ stock: 5 });
      const res = await place(
        randomUUID(),
        await orderFor([line(kettle, 2)]),
      ).expect(201);
      const { id } = res.body as Receipt;
      expect(await stockOf(kettle)).toBe(3);

      const cancel = () =>
        http()
          .patch(`/orders/${id}/status`)
          .set(bearer(adminToken))
          .send({ status: 'CANCELLED' })
          .expect(200);
      await cancel();
      await cancel();

      expect(await stockOf(kettle)).toBe(5);
    });
  });
});
