import request from 'supertest';
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

const PRODUCT_FIELDS = [
  'brand',
  'category',
  'categoryId',
  'costPrice',
  'createdAt',
  'description',
  'id',
  'name',
  'price',
  'sku',
  'status',
  'stock',
  'updatedAt',
  'version',
];

interface ProductBody {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  categoryId: string;
  category: string;
  brand: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  price: number;
  costPrice: number | null;
  stock: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface HistoryBody {
  data: {
    id: string;
    change: string;
    occurredAt: string;
    actor: string | null;
  }[];
}

const keysOf = (value: unknown) => Object.keys(value as object).sort();
const prd = (product: { number: number }) => `PRD-${product.number}`;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Products (e2e)', () => {
  let ctx: TestContext;
  let adminToken: string;
  let staffToken: string;
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string, token = adminToken) =>
    http().get(path).set(bearer(token));
  const post = (path: string, body: object, token = adminToken) =>
    http().post(path).set(bearer(token)).send(body);
  const patch = (path: string, body: object, token = adminToken) =>
    http().patch(path).set(bearer(token)).send(body);

  const idsOf = (res: { body: unknown }): string[] =>
    (res.body as { data: ProductBody[] }).data.map((p) => p.id);

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
  // Keeps the signed-in users; only the catalogue data starts over.
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "Order", "Product"',
    );
  });

  const validBody = async (overrides: Record<string, unknown> = {}) => ({
    name: 'Ceramic Mug',
    sku: 'MUG-001',
    categoryId: (await getCategory(ctx.prisma)).id,
    price: 12.5,
    ...overrides,
  });

  describe('access control', () => {
    const routes: [string, string][] = [
      ['get', '/products'],
      ['get', '/products/PRD-1001'],
      ['get', '/products/PRD-1001/history'],
      ['post', '/products'],
      ['patch', '/products/PRD-1001'],
      ['post', '/products/archive'],
      ['get', '/categories'],
    ];

    it('requires authentication on every route', async () => {
      for (const [method, path] of routes) {
        const req = http()[method as 'get' | 'post' | 'patch'](path);
        await req.expect(401);
        await http()
          [method as 'get' | 'post' | 'patch'](path)
          .set(bearer('not-a-real-token'))
          .expect(401);
      }
    });

    it('blocks a user whose email is not verified', async () => {
      await createUser(ctx.prisma, {
        email: 'unverified@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'unverified@example.com');
      for (const path of ['/products', '/categories']) {
        const res = await get(path, accessToken).expect(403);
        expect(res.body.message).toBe('Email verification required');
      }
    });

    it('lets staff run the catalogue: view, create and edit', async () => {
      await get('/products', staffToken).expect(200);
      await get('/categories', staffToken).expect(200);
      const created = await post(
        '/products',
        await validBody(),
        staffToken,
      ).expect(201);
      const { id, version } = created.body as ProductBody;
      await patch(`/products/${id}`, { version, price: 20 }, staffToken).expect(
        200,
      );
      await get(`/products/${id}`, staffToken).expect(200);
      await get(`/products/${id}/history`, staffToken).expect(200);
    });

    it('keeps archiving for administrators', async () => {
      const product = await createProduct(ctx.prisma);
      const res = await post(
        '/products/archive',
        { productIds: [prd(product)] },
        staffToken,
      ).expect(403);
      expect(res.body.message).toBe('Insufficient permissions');
      expect(
        await ctx.prisma.product.count({ where: { archivedAt: null } }),
      ).toBe(1);

      await post('/products/archive', { productIds: [prd(product)] }).expect(
        200,
      );
    });

    it('offers no way to delete a product outright', async () => {
      const product = await createProduct(ctx.prisma);
      await http()
        .delete(`/products/${prd(product)}`)
        .set(bearer(adminToken))
        .expect(404);
      await http()
        .put(`/products/${prd(product)}`)
        .set(bearer(adminToken))
        .send({})
        .expect(404);
      expect(await ctx.prisma.product.count()).toBe(1);
    });
  });

  describe('GET /categories', () => {
    it('lists the seeded categories by name', async () => {
      const res = await get('/categories').expect(200);
      const body = res.body as { data: { id: string; name: string }[] };
      expect(body.data.map((c) => c.name)).toEqual([
        'Accessories',
        'Electronics',
        'Furniture',
        'Home & Kitchen',
        'Office Supplies',
        'Sports & Outdoors',
      ]);
      expect(keysOf(body.data[0])).toEqual(['id', 'name']);
    });
  });

  describe('GET /products', () => {
    it('returns the products with exactly the fields the dashboard shows', async () => {
      const product = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        sku: 'MUG-001',
        brand: 'Hearthstone',
        description: 'Holds 350 ml.',
        category: 'Home & Kitchen',
        price: '12.50',
        costPrice: '4.25',
        stock: 7,
      });
      const res = await get('/products').expect(200);
      const body = res.body as {
        data: ProductBody[];
        meta: Record<string, number>;
      };
      expect(body.meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      });
      expect(keysOf(body.data[0])).toEqual(PRODUCT_FIELDS);
      expect(body.data[0]).toEqual({
        id: prd(product),
        name: 'Ceramic Mug',
        sku: 'MUG-001',
        description: 'Holds 350 ml.',
        categoryId: product.categoryId,
        category: 'Home & Kitchen',
        brand: 'Hearthstone',
        status: 'ACTIVE',
        price: 12.5,
        costPrice: 4.25,
        stock: 7,
        version: 1,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
      });
    });

    it('lists the newest first and pages without overlap', async () => {
      const now = Date.now();
      const made = [];
      for (let i = 0; i < 5; i++) {
        made.push(
          await createProduct(ctx.prisma, {
            createdAt: new Date(now - (5 - i) * DAY_MS),
          }),
        );
      }
      const newestFirst = [...made].reverse().map(prd);

      const first = await get('/products?pageSize=2').expect(200);
      expect(idsOf(first)).toEqual(newestFirst.slice(0, 2));
      expect(first.body.meta).toEqual({
        page: 1,
        pageSize: 2,
        total: 5,
        totalPages: 3,
      });
      expect(idsOf(await get('/products?pageSize=2&page=2'))).toEqual(
        newestFirst.slice(2, 4),
      );
      expect(idsOf(await get('/products?pageSize=2&page=3'))).toEqual(
        newestFirst.slice(4),
      );
    });

    it('returns an empty page, with the true totals, past the end', async () => {
      await createProduct(ctx.prisma);
      const res = await get('/products?page=9').expect(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ page: 9, total: 1, totalPages: 1 });
    });

    it('never lists archived products', async () => {
      const kept = await createProduct(ctx.prisma);
      await createProduct(ctx.prisma, { archived: true });
      const res = await get('/products').expect(200);
      expect(idsOf(res)).toEqual([prd(kept)]);
      expect(res.body.meta.total).toBe(1);
    });

    describe('search', () => {
      beforeEach(async () => {
        await createProduct(ctx.prisma, {
          name: 'Ceramic Mug',
          sku: 'HK-MUG-350',
        });
        await createProduct(ctx.prisma, {
          name: 'Linen Apron',
          sku: 'HK-APR-LIN',
        });
        await createProduct(ctx.prisma, {
          name: '100% Cotton Towel',
          sku: 'BTH_TWL_01',
        });
      });

      const names = async (search: string) =>
        (
          (
            await get(`/products?search=${encodeURIComponent(search)}`).expect(
              200,
            )
          ).body as { data: ProductBody[] }
        ).data
          .map((p) => p.name)
          .sort();

      it('matches the name, in any case', async () => {
        expect(await names('mug')).toEqual(['Ceramic Mug']);
        expect(await names('LINEN')).toEqual(['Linen Apron']);
      });

      it('matches the SKU, in any case', async () => {
        expect(await names('hk-apr')).toEqual(['Linen Apron']);
        expect(await names('HK-')).toEqual(['Ceramic Mug', 'Linen Apron']);
      });

      it('treats % and _ literally', async () => {
        expect(await names('100%')).toEqual(['100% Cotton Towel']);
        expect(await names('%')).toEqual(['100% Cotton Towel']);
        expect(await names('_')).toEqual(['100% Cotton Towel']);
        expect(await names('BTH_TWL')).toEqual(['100% Cotton Towel']);
        expect(await names('BTH%TWL')).toEqual([]);
      });

      it('finds a product by its id, with or without the prefix', async () => {
        const [target] = await ctx.prisma.product.findMany({
          where: { name: 'Linen Apron' },
        });
        for (const term of [
          `PRD-${target.number}`,
          `prd-${target.number}`,
          `prd${target.number}`,
          String(target.number),
        ]) {
          expect(await names(term)).toContain('Linen Apron');
        }
      });

      it('ignores surrounding spaces and returns nothing for no match', async () => {
        expect(await names('  mug  ')).toEqual(['Ceramic Mug']);
        expect(await names('zzz-nothing')).toEqual([]);
      });
    });

    describe('filters', () => {
      it('narrows to a category', async () => {
        const electronics = await createProduct(ctx.prisma, {
          category: 'Electronics',
        });
        await createProduct(ctx.prisma, { category: 'Furniture' });
        const res = await get(
          `/products?categoryId=${electronics.categoryId}`,
        ).expect(200);
        expect(idsOf(res)).toEqual([prd(electronics)]);
      });

      it('derives the status the way the dashboard does', async () => {
        const active = await createProduct(ctx.prisma, { stock: 3 });
        const outOfStock = await createProduct(ctx.prisma, { stock: 0 });
        const inactive = await createProduct(ctx.prisma, {
          status: 'INACTIVE',
          stock: 8,
        });
        // Inactive wins over out of stock.
        const inactiveEmpty = await createProduct(ctx.prisma, {
          status: 'INACTIVE',
          stock: 0,
        });

        const ids = async (status: string) =>
          idsOf(await get(`/products?status=${status}`).expect(200))
            .slice()
            .sort();

        expect(await ids('ACTIVE')).toEqual([prd(active)]);
        expect(await ids('OUT_OF_STOCK')).toEqual([prd(outOfStock)]);
        expect(await ids('INACTIVE')).toEqual(
          [prd(inactive), prd(inactiveEmpty)].sort(),
        );
      });

      it('combines search, category and status', async () => {
        const hit = await createProduct(ctx.prisma, {
          name: 'Oak Shelf',
          category: 'Furniture',
          stock: 0,
        });
        await createProduct(ctx.prisma, {
          name: 'Oak Shelf Mini',
          category: 'Furniture',
          stock: 4,
        });
        await createProduct(ctx.prisma, {
          name: 'Oak Frame',
          category: 'Accessories',
          stock: 0,
        });
        const res = await get(
          `/products?search=shelf&categoryId=${hit.categoryId}&status=OUT_OF_STOCK`,
        ).expect(200);
        expect(idsOf(res)).toEqual([prd(hit)]);
      });
    });

    it.each([
      ['page 0', 'page=0'],
      ['a non-numeric page', 'page=two'],
      ['pageSize 101', 'pageSize=101'],
      ['an unknown status', 'status=ARCHIVED'],
      ['a lower-case status', 'status=active'],
      ['a category that is not a uuid', 'categoryId=Electronics'],
      ['an over-long search', `search=${'a'.repeat(101)}`],
      ['an unknown parameter', 'sortBy=price'],
    ])('answers 400 for %s', async (_label, query) => {
      await get(`/products?${query}`).expect(400);
    });
  });

  describe('GET /products/:productId', () => {
    it('returns one product', async () => {
      const product = await createProduct(ctx.prisma, { price: '99.90' });
      const res = await get(`/products/${prd(product)}`).expect(200);
      expect(keysOf(res.body)).toEqual(PRODUCT_FIELDS);
      expect(res.body).toMatchObject({ id: prd(product), price: 99.9 });
    });

    it('accepts the id in any case', async () => {
      const product = await createProduct(ctx.prisma);
      await get(`/products/prd-${product.number}`).expect(200);
    });

    it('answers 404 for an unknown or archived product', async () => {
      const archived = await createProduct(ctx.prisma, { archived: true });
      for (const id of ['PRD-999999', prd(archived)]) {
        const res = await get(`/products/${id}`).expect(404);
        expect(res.body.message).toBe('Product not found');
      }
    });

    it.each(['1001', 'CUS-1001', 'PRD-0', 'PRD-abc', 'PRD-2147483648'])(
      'answers 400 for the malformed id %s',
      async (id) => {
        await get(`/products/${id}`).expect(400);
        await get(`/products/${id}/history`).expect(400);
      },
    );
  });

  describe('POST /products', () => {
    it('creates a product with the defaults and records who created it', async () => {
      const res = await post('/products', await validBody()).expect(201);
      const body = res.body as ProductBody;
      expect(keysOf(body)).toEqual(PRODUCT_FIELDS);
      expect(body).toMatchObject({
        name: 'Ceramic Mug',
        sku: 'MUG-001',
        category: 'Electronics',
        brand: null,
        description: null,
        status: 'ACTIVE',
        price: 12.5,
        costPrice: null,
        stock: 0,
        version: 1,
      });
      expect(body.id).toMatch(/^PRD-\d+$/);

      const history = await get(`/products/${body.id}/history`).expect(200);
      expect((history.body as HistoryBody).data).toEqual([
        expect.objectContaining({
          change: 'Product created',
          actor: 'Ada Admin',
        }),
      ]);
    });

    it('stores every optional field, trimmed', async () => {
      const res = await post(
        '/products',
        await validBody({
          name: '  Ceramic Mug  ',
          sku: '  MUG-002  ',
          brand: ' Hearthstone ',
          description: ' Holds 350 ml. ',
          status: 'INACTIVE',
          costPrice: 4.25,
          stock: 40,
        }),
      ).expect(201);
      expect(res.body).toMatchObject({
        name: 'Ceramic Mug',
        sku: 'MUG-002',
        brand: 'Hearthstone',
        description: 'Holds 350 ml.',
        status: 'INACTIVE',
        costPrice: 4.25,
        stock: 40,
      });
    });

    it('turns a blank brand into none', async () => {
      const res = await post(
        '/products',
        await validBody({ brand: '   ', description: '' }),
      ).expect(201);
      expect(res.body).toMatchObject({ brand: null, description: null });
    });

    it('keeps the cents exact', async () => {
      const res = await post(
        '/products',
        await validBody({ price: 19.99, costPrice: 0.1 }),
      ).expect(201);
      expect(res.body).toMatchObject({ price: 19.99, costPrice: 0.1 });
      const stored = await ctx.prisma.product.findFirstOrThrow();
      expect(stored.price.toFixed(2)).toBe('19.99');
    });

    it('refuses a SKU that is taken, whatever its case', async () => {
      await createProduct(ctx.prisma, { sku: 'Mug-001' });
      const res = await post(
        '/products',
        await validBody({ sku: 'MUG-001' }),
      ).expect(409);
      expect(res.body.message).toBe('A product with this SKU already exists');
      expect(await ctx.prisma.product.count()).toBe(1);
    });

    it('keeps the SKU of an archived product reserved', async () => {
      await createProduct(ctx.prisma, { sku: 'OLD-001', archived: true });
      await post('/products', await validBody({ sku: 'old-001' })).expect(409);
    });

    it('refuses a category that does not exist', async () => {
      const res = await post(
        '/products',
        await validBody({ categoryId: '0b6c1f2e-7d6c-4f55-9d35-0d3c8e0b1a11' }),
      ).expect(400);
      expect(res.body.message).toBe('Unknown category');
      expect(await ctx.prisma.product.count()).toBe(0);
    });

    it.each([
      ['no name', { name: undefined }],
      ['a negative price', { price: -1 }],
      ['a price with three decimals', { price: 1.005 }],
      ['a fractional stock', { stock: 1.5 }],
      ['a negative stock', { stock: -1 }],
      ['a SKU with a space', { sku: 'MUG 001' }],
      ['a null status', { status: null }],
    ])('answers 400 for %s', async (_label, overrides) => {
      await post('/products', await validBody(overrides)).expect(400);
      expect(await ctx.prisma.product.count()).toBe(0);
    });

    it.each([
      ['an id', { id: 'x' }],
      ['a number', { number: 1 }],
      ['a version', { version: 5 }],
      ['an archive time', { archivedAt: '2026-01-01T00:00:00Z' }],
    ])('refuses to set %s (mass assignment)', async (_label, extra) => {
      await post('/products', await validBody(extra)).expect(400);
      expect(await ctx.prisma.product.count()).toBe(0);
    });
  });

  describe('PATCH /products/:productId', () => {
    const history = async (id: string) =>
      (await get(`/products/${id}/history`).expect(200)).body as HistoryBody;

    it('applies the changed fields, bumps the version and returns the product', async () => {
      const product = await createProduct(ctx.prisma, {
        name: 'Mug',
        price: '10.00',
        stock: 5,
      });
      const other = await getCategory(ctx.prisma, 'Furniture');

      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        name: 'Stoneware Mug',
        brand: 'Hearthstone',
        categoryId: other.id,
        price: 11.5,
        costPrice: 3,
        stock: 9,
        status: 'INACTIVE',
      }).expect(200);

      expect(res.body).toMatchObject({
        id: prd(product),
        name: 'Stoneware Mug',
        brand: 'Hearthstone',
        category: 'Furniture',
        categoryId: other.id,
        price: 11.5,
        costPrice: 3,
        stock: 9,
        status: 'INACTIVE',
        version: 2,
      });
      expect(keysOf(res.body)).toEqual(PRODUCT_FIELDS);
    });

    it('writes one history entry per kind of change, with the actor', async () => {
      const product = await createProduct(ctx.prisma, {
        name: 'Mug',
        price: '10.00',
        costPrice: '2.00',
        stock: 5,
      });
      await patch(
        `/products/${prd(product)}`,
        {
          version: 1,
          name: 'Stoneware Mug',
          price: 12,
          costPrice: null,
          stock: 1240,
          status: 'INACTIVE',
        },
        staffToken,
      ).expect(200);

      const entries = (await history(prd(product))).data;
      expect(entries.map((e) => e.change).sort()).toEqual(
        [
          'Details updated: name',
          'Price changed from $10.00 to $12.00',
          'Cost price changed from $2.00 to Not set',
          'Status changed from Active to Inactive',
          'Stock updated from 5 to 1,240',
        ].sort(),
      );
      expect(new Set(entries.map((e) => e.actor))).toEqual(
        new Set(['Sam Staff']),
      );
    });

    it('lists the history newest first', async () => {
      const product = await createProduct(ctx.prisma);
      const base = Date.now();
      await ctx.prisma.productEvent.createMany({
        data: [
          {
            productId: product.id,
            type: 'CREATED',
            data: {},
            createdAt: new Date(base - 3 * DAY_MS),
          },
          {
            productId: product.id,
            type: 'STOCK_CHANGED',
            data: { from: 1, to: 2, reason: 'MANUAL' },
            createdAt: new Date(base - 2 * DAY_MS),
          },
          {
            productId: product.id,
            type: 'ARCHIVED',
            data: {},
            createdAt: new Date(base - DAY_MS),
          },
        ],
      });
      const entries = (await history(prd(product))).data;
      expect(entries.map((e) => e.change)).toEqual([
        'Product archived',
        'Stock updated from 1 to 2',
        'Product created',
      ]);
      expect(keysOf(entries[0])).toEqual([
        'actor',
        'change',
        'id',
        'occurredAt',
      ]);
      expect(entries[0].actor).toBeNull();
    });

    it('leaves what it was not given alone, and clears with null or blank', async () => {
      const product = await createProduct(ctx.prisma, {
        brand: 'Hearthstone',
        description: 'Holds 350 ml.',
        costPrice: '2.00',
        stock: 4,
      });
      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        brand: '  ',
        description: null,
        costPrice: null,
      }).expect(200);
      expect(res.body).toMatchObject({
        brand: null,
        description: null,
        costPrice: null,
        stock: 4,
        price: 10,
      });
    });

    it('acknowledges a save that changes nothing without touching the version', async () => {
      const product = await createProduct(ctx.prisma, {
        name: 'Mug',
        price: '10.00',
        stock: 5,
      });
      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        name: 'Mug',
        price: 10,
        stock: 5,
        status: 'ACTIVE',
      }).expect(200);
      expect(res.body.version).toBe(1);
      expect(await ctx.prisma.productEvent.count()).toBe(0);
    });

    it('answers 400 when only the version is sent', async () => {
      const product = await createProduct(ctx.prisma);
      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
      }).expect(400);
      expect(res.body.message).toBe('No changes supplied');
    });

    it('refuses an edit made on a stale version and changes nothing', async () => {
      const product = await createProduct(ctx.prisma, { stock: 5 });
      await patch(`/products/${prd(product)}`, {
        version: 1,
        price: 11,
      }).expect(200);

      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        stock: 99,
      }).expect(409);
      expect(res.body.message).toBe(
        'This product was changed by someone else. Reload it and try again.',
      );
      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored).toMatchObject({ stock: 5, version: 2 });
    });

    it('refuses an edit that would overwrite stock moved by something else', async () => {
      const product = await createProduct(ctx.prisma, { stock: 5 });
      // What an order does: stock moves and the version with it.
      await ctx.prisma.product.update({
        where: { id: product.id },
        data: { stock: 4, version: { increment: 1 } },
      });
      await patch(`/products/${prd(product)}`, {
        version: 1,
        stock: 5,
        name: 'Renamed',
      }).expect(409);
      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored).toMatchObject({ stock: 4, name: product.name });
    });

    it('lets exactly one of two simultaneous edits from the same version win', async () => {
      const product = await createProduct(ctx.prisma, { stock: 5 });
      const results = await Promise.all([
        patch(`/products/${prd(product)}`, { version: 1, stock: 10 }),
        patch(`/products/${prd(product)}`, { version: 1, stock: 20 }),
        patch(`/products/${prd(product)}`, { version: 1, price: 99 }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409]);

      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.version).toBe(2);
      // Exactly one change was recorded, for the winner.
      expect(await ctx.prisma.productEvent.count()).toBe(1);
    });

    it('refuses a SKU that another product has, whatever its case', async () => {
      await createProduct(ctx.prisma, { sku: 'TAKEN-1' });
      const product = await createProduct(ctx.prisma, { sku: 'MINE-1' });
      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        sku: 'taken-1',
      }).expect(409);
      expect(res.body.message).toBe('A product with this SKU already exists');

      // Changing only its case is the same product's own SKU, so it is allowed.
      await patch(`/products/${prd(product)}`, {
        version: 1,
        sku: 'mine-1',
      }).expect(200);
    });

    it('refuses an unknown category', async () => {
      const product = await createProduct(ctx.prisma);
      const res = await patch(`/products/${prd(product)}`, {
        version: 1,
        categoryId: '0b6c1f2e-7d6c-4f55-9d35-0d3c8e0b1a11',
      }).expect(400);
      expect(res.body.message).toBe('Unknown category');
    });

    it('answers 404 for an unknown or archived product', async () => {
      const archived = await createProduct(ctx.prisma, { archived: true });
      await patch('/products/PRD-999999', { version: 1, stock: 1 }).expect(404);
      await patch(`/products/${prd(archived)}`, {
        version: 1,
        stock: 1,
      }).expect(404);
    });

    it.each([
      ['a missing version', { stock: 1 }],
      ['a version of 0', { version: 0, stock: 1 }],
      ['a null name', { version: 1, name: null }],
      ['a null price', { version: 1, price: null }],
      ['a negative stock', { version: 1, stock: -1 }],
      ['an unknown field', { version: 1, number: 7 }],
    ])('answers 400 for %s', async (_label, body) => {
      const product = await createProduct(ctx.prisma);
      await patch(`/products/${prd(product)}`, body).expect(400);
    });
  });

  describe('POST /products/archive', () => {
    it('hides the products and says how many it archived', async () => {
      const a = await createProduct(ctx.prisma);
      const b = await createProduct(ctx.prisma);
      const kept = await createProduct(ctx.prisma);

      const res = await post('/products/archive', {
        productIds: [prd(a), prd(b)],
      }).expect(200);
      expect(res.body).toEqual({ archived: 2 });

      expect(idsOf(await get('/products').expect(200))).toEqual([prd(kept)]);
      await get(`/products/${prd(a)}`).expect(404);
      await get(`/products/${prd(b)}/history`).expect(404);
    });

    it('records who archived each product and bumps its version', async () => {
      const product = await createProduct(ctx.prisma);
      await post('/products/archive', { productIds: [prd(product)] }).expect(
        200,
      );
      const [event] = await ctx.prisma.productEvent.findMany({
        include: { actor: true },
      });
      expect(event).toMatchObject({
        productId: product.id,
        type: 'ARCHIVED',
      });
      expect(event.actor?.name).toBe('Ada Admin');
      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.version).toBe(2);
      expect(stored.archivedAt).not.toBeNull();
    });

    it('is idempotent: repeats and unknown ids archive nothing more', async () => {
      const product = await createProduct(ctx.prisma);
      await post('/products/archive', { productIds: [prd(product)] }).expect(
        200,
      );
      const again = await post('/products/archive', {
        productIds: [prd(product), 'PRD-999999'],
      }).expect(200);
      expect(again.body).toEqual({ archived: 0 });
      expect(await ctx.prisma.productEvent.count()).toBe(1);
    });

    it('accepts ids in any case and counts a product once', async () => {
      const product = await createProduct(ctx.prisma);
      const res = await post('/products/archive', {
        productIds: [`prd-${product.number}`],
      }).expect(200);
      expect(res.body).toEqual({ archived: 1 });
    });

    it('keeps what orders recorded about an archived product', async () => {
      const product = await createProduct(ctx.prisma, {
        name: 'Ceramic Mug',
        price: '12.50',
      });
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer, {
        items: [{ product, quantity: 2 }],
      });

      await post('/products/archive', { productIds: [prd(product)] }).expect(
        200,
      );

      const [line] = await ctx.prisma.orderItem.findMany({
        where: { orderId: order.id },
      });
      expect(line).toMatchObject({
        productId: prd(product),
        productName: 'Ceramic Mug',
        sku: product.sku,
        quantity: 2,
        catalogProductId: product.id,
      });
      expect(line.unitPrice.toFixed(2)).toBe('12.50');
    });

    it.each([
      ['an empty list', { productIds: [] }],
      ['a missing list', {}],
      ['a repeated id', { productIds: ['PRD-1001', 'PRD-1001'] }],
      ['a bare number', { productIds: ['1001'] }],
      ['another kind of id', { productIds: ['CUS-1001'] }],
      ['an unknown field', { productIds: ['PRD-1001'], hard: true }],
    ])('answers 400 for %s', async (_label, body) => {
      await post('/products/archive', body).expect(400);
    });
  });
});
