import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bearer,
  createCustomer,
  createOrder,
  createProduct,
  createTestApp,
  createUser,
  getCategory,
  login,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

describe('PKR currency policy (e2e)', () => {
  let ctx: TestContext;
  let token: string;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'currency-admin@example.com',
      role: 'ADMIN',
    });
    token = (await login(ctx.app, 'currency-admin@example.com')).accessToken;
  });

  it('corrects all saved product currency labels without changing amounts, order snapshots or already-PKR products', async () => {
    const products = [
      await createProduct(ctx.prisma, {
        currency: 'USD',
        price: 3500.25,
        costPrice: 2400.5,
      }),
      await createProduct(ctx.prisma, {
        currency: 'USD',
        status: 'INACTIVE',
        price: 0,
      }),
      await createProduct(ctx.prisma, {
        currency: 'USD',
        archived: true,
        price: 1800,
      }),
    ];
    const existingPkr = await createProduct(ctx.prisma, {
      currency: 'PKR',
      price: 1500,
    });
    const order = await createOrder(
      ctx.prisma,
      await createCustomer(ctx.prisma),
      {
        currency: 'USD',
        items: [{ product: products[0], quantity: 2 }],
      },
    );
    const orderBefore = await ctx.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, events: true },
    });
    const sql = readFileSync(
      resolve(
        __dirname,
        '../prisma/migrations/20261016110000_product_currency_pkr/migration.sql',
      ),
      'utf8',
    );
    await ctx.prisma.$executeRawUnsafe(sql);
    for (const before of products) {
      const after = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after).toEqual({
        ...before,
        currency: 'PKR',
        version: before.version + 1,
        updatedAt: expect.any(Date),
      });
      const events = await ctx.prisma.productEvent.findMany({
        where: { productId: before.id },
      });
      expect(events).toHaveLength(before.costPrice === null ? 1 : 2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'PRICE_CHANGED',
            actorId: null,
            data: {
              field: 'price',
              from: Number(before.price),
              to: Number(before.price),
              fromCurrency: 'USD',
              currency: 'PKR',
            },
          }),
        ]),
      );
      if (before.costPrice !== null) {
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              data: {
                field: 'costPrice',
                from: Number(before.costPrice),
                to: Number(before.costPrice),
                fromCurrency: 'USD',
                currency: 'PKR',
              },
            }),
          ]),
        );
      }
    }
    expect(
      await ctx.prisma.product.findUniqueOrThrow({
        where: { id: existingPkr.id },
      }),
    ).toEqual(existingPkr);
    expect(
      await ctx.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true, events: true },
      }),
    ).toEqual(orderBefore);
    await http()
      .get(`/storefront/products/PRD-${products[0].number}`)
      .expect(200);
    await http()
      .get(`/storefront/products/PRD-${products[1].number}`)
      .expect(404);
    await http()
      .get(`/storefront/products/PRD-${products[2].number}`)
      .expect(404);
    const afterFirstRun = await ctx.prisma.product.findMany({
      orderBy: { number: 'asc' },
    });
    const eventCount = await ctx.prisma.productEvent.count();
    await ctx.prisma.$executeRawUnsafe(sql);
    expect(
      await ctx.prisma.product.findMany({ orderBy: { number: 'asc' } }),
    ).toEqual(afterFirstRun);
    expect(await ctx.prisma.productEvent.count()).toBe(eventCount);
  });

  it('defaults API writes to PKR and refuses a client-selected USD currency', async () => {
    const body = {
      name: 'Mug',
      sku: 'PKR-DEFAULT',
      categoryId: (await getCategory(ctx.prisma)).id,
      price: 1500,
    };
    const created = await http()
      .post('/products')
      .set(bearer(token))
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({ currency: 'PKR', price: 1500 });
    const invalid = await http()
      .post('/products')
      .set(bearer(token))
      .send({ ...body, sku: 'NO-USD', currency: 'USD' })
      .expect(400);
    expect(invalid.body.message).toContain('currency must be PKR');
    expect(await ctx.prisma.product.count()).toBe(1);
  });

  it('sets both database column defaults to PKR without removing the legacy enum value', async () => {
    const defaults = await ctx.prisma.$queryRaw<
      { table_name: string; column_default: string }[]
    >`
      SELECT table_name, column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name IN ('Product','Order') AND column_name='currency'
      ORDER BY table_name`;
    expect(defaults).toHaveLength(2);
    for (const column of defaults)
      expect(column.column_default).toContain("'PKR'");
    const values = await ctx.prisma.$queryRaw<
      { value: string }[]
    >`SELECT unnest(enum_range(NULL::"Currency"))::text AS value`;
    expect(values.map((row) => row.value)).toEqual(
      expect.arrayContaining(['USD', 'PKR']),
    );
  });

  it('keeps USD product and order amounts readable without converting or relabelling them', async () => {
    const product = await createProduct(ctx.prisma, {
      currency: 'USD',
      price: 10,
      costPrice: 2,
    });
    const customer = await createCustomer(ctx.prisma);
    const order = await createOrder(ctx.prisma, customer, {
      currency: 'USD',
      total: 15,
    });
    const path = `/products/PRD-${product.number}`;
    await http()
      .get(path)
      .set(bearer(token))
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          currency: 'USD',
          price: 10,
          costPrice: 2,
        }),
      );
    await http()
      .patch(path)
      .set(bearer(token))
      .send({ version: product.version, name: 'Legacy mug' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          currency: 'USD',
          price: 10,
          costPrice: 2,
        }),
      );
    await http()
      .get(`/orders/ORD-${order.number}`)
      .set(bearer(token))
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ currency: 'USD', total: 15 }),
      );
    await http().get(`/storefront/products/PRD-${product.number}`).expect(404);
  });

  it('requires explicit prices when making a legacy product available in PKR', async () => {
    const product = await createProduct(ctx.prisma, {
      currency: 'USD',
      price: 10,
      costPrice: 2,
    });
    const path = `/products/PRD-${product.number}`;
    for (const changes of [
      { currency: 'PKR' },
      { currency: 'PKR', price: 2800 },
    ]) {
      await http()
        .patch(path)
        .set(bearer(token))
        .send({ version: product.version, ...changes })
        .expect(400);
    }
    const current = await ctx.prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(current.currency).toBe('USD');
    expect(current.price.toString()).toBe('10');
    expect(current.version).toBe(product.version);
    const result = await http()
      .patch(path)
      .set(bearer(token))
      .send({
        version: product.version,
        currency: 'PKR',
        price: 2800,
        costPrice: 560,
      })
      .expect(200);
    expect(result.body).toMatchObject({
      currency: 'PKR',
      price: 2800,
      costPrice: 560,
    });
    await http().get(`/storefront/products/PRD-${product.number}`).expect(200);
    await http()
      .patch(path)
      .set(bearer(token))
      .send({ version: result.body.version, currency: 'USD' })
      .expect(400);
  });
});
