import {
  createCustomer,
  createOrder,
  createProduct,
  createTestApp,
  createUser,
  getCategory,
  resetDatabase,
  type TestContext,
} from './helpers';

const CATEGORIES = [
  'Accessories',
  'Electronics',
  'Furniture',
  'Home & Kitchen',
  'Office Supplies',
  'Sports & Outdoors',
];

/** The database rules the migration adds on top of what Prisma models. */
describe('Products schema (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  const productData = async (overrides: Record<string, unknown> = {}) => ({
    name: 'Mug',
    sku: 'MUG-001',
    categoryId: (await getCategory(ctx.prisma)).id,
    price: '12.50',
    stock: 5,
    ...overrides,
  });

  it('seeds the categories the product screens have always offered', async () => {
    const categories = await ctx.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
    expect(categories.map((c) => c.name)).toEqual(CATEGORIES);
  });

  it('numbers products from 1001 upwards', async () => {
    const product = await createProduct(ctx.prisma);
    expect(product.number).toBeGreaterThanOrEqual(1001);
  });

  it('defaults a new product to active, in stock count 0 and version 1', async () => {
    const product = await ctx.prisma.product.create({
      data: {
        name: 'Mug',
        sku: 'MUG-DEFAULTS',
        categoryId: (await getCategory(ctx.prisma)).id,
        price: '1.00',
      },
    });
    expect(product).toMatchObject({
      status: 'ACTIVE',
      stock: 0,
      version: 1,
      archivedAt: null,
      costPrice: null,
    });
  });

  describe('currency and storefront metadata', () => {
    it('prices a product in USD, with no subtitle or images, unless told otherwise', async () => {
      const product = await createProduct(ctx.prisma);
      expect(product).toMatchObject({
        currency: 'USD',
        subtitle: null,
        imageUrl: null,
        galleryUrls: [],
      });
    });

    it('keeps the currency, subtitle and ordered gallery it is given', async () => {
      const gallery = [
        'https://cdn.example.com/b.jpg',
        'https://cdn.example.com/a.jpg',
      ];
      const product = await createProduct(ctx.prisma, {
        currency: 'PKR',
        subtitle: 'Wireless, noise cancelling',
        imageUrl: 'https://cdn.example.com/main.jpg',
        galleryUrls: gallery,
      });
      const stored = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored).toMatchObject({
        currency: 'PKR',
        subtitle: 'Wireless, noise cancelling',
        imageUrl: 'https://cdn.example.com/main.jpg',
        galleryUrls: gallery,
      });
    });

    it('refuses a currency the system does not know', async () => {
      const product = await createProduct(ctx.prisma);
      await expect(
        ctx.prisma
          .$executeRaw`UPDATE "Product" SET "currency" = 'EUR' WHERE "id" = ${product.id}`,
      ).rejects.toThrow();
    });
  });

  describe('stock', () => {
    it('is never negative, on insert or update', async () => {
      await expect(
        ctx.prisma.product.create({
          data: await productData({ stock: -1 }),
        }),
      ).rejects.toThrow(/Product_stock_check/);

      const product = await createProduct(ctx.prisma, { stock: 2 });
      await expect(
        ctx.prisma.product.update({
          where: { id: product.id },
          data: { stock: { decrement: 3 } },
        }),
      ).rejects.toThrow(/Product_stock_check/);
      const reread = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reread.stock).toBe(2);
    });

    it('can reach exactly zero', async () => {
      const product = await createProduct(ctx.prisma, { stock: 2 });
      const updated = await ctx.prisma.product.update({
        where: { id: product.id },
        data: { stock: { decrement: 2 } },
      });
      expect(updated.stock).toBe(0);
    });
  });

  describe('prices', () => {
    it('rejects a negative selling price', async () => {
      await expect(
        ctx.prisma.product.create({
          data: await productData({ price: '-0.01' }),
        }),
      ).rejects.toThrow(/Product_prices_check/);
    });

    it('rejects a negative cost price but accepts none, zero or a positive one', async () => {
      await expect(
        ctx.prisma.product.create({
          data: await productData({ sku: 'NEG-COST', costPrice: '-1.00' }),
        }),
      ).rejects.toThrow(/Product_prices_check/);

      for (const [sku, costPrice] of [
        ['COST-NONE', null],
        ['COST-ZERO', '0.00'],
        ['COST-SOME', '7.25'],
      ] as const) {
        await expect(
          ctx.prisma.product.create({
            data: await productData({ sku, costPrice }),
          }),
        ).resolves.toBeDefined();
      }
    });

    it('rejects a version below 1', async () => {
      await expect(
        ctx.prisma.product.create({
          data: await productData({ version: 0 }),
        }),
      ).rejects.toThrow(/Product_version_check/);
    });

    it('stores exact two-decimal amounts', async () => {
      const product = await createProduct(ctx.prisma, { price: '19.99' });
      const reread = await ctx.prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(reread.price.toString()).toBe('19.99');
    });
  });

  describe('SKU', () => {
    it('is unique whatever its case', async () => {
      await createProduct(ctx.prisma, { sku: 'Mug-001' });
      await expect(
        createProduct(ctx.prisma, { sku: 'MUG-001' }),
      ).rejects.toMatchObject({
        code: 'P2002',
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: 'Product_sku_lower_key' } },
          },
        },
      });
      await expect(
        createProduct(ctx.prisma, { sku: 'MUG-002' }),
      ).resolves.toBeDefined();
    });

    it('stays reserved after the product is archived', async () => {
      await createProduct(ctx.prisma, { sku: 'GONE-001', archived: true });
      await expect(
        createProduct(ctx.prisma, { sku: 'gone-001' }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('relations', () => {
    it('keeps a category that still has products', async () => {
      const product = await createProduct(ctx.prisma);
      await expect(
        ctx.prisma.category.delete({ where: { id: product.categoryId } }),
      ).rejects.toThrow();
    });

    it('keeps a product that an order line refers to', async () => {
      const product = await createProduct(ctx.prisma);
      const customer = await createCustomer(ctx.prisma);
      await createOrder(ctx.prisma, customer, {
        items: [{ product, quantity: 1 }],
      });
      await expect(
        ctx.prisma.product.delete({ where: { id: product.id } }),
      ).rejects.toThrow();
      expect(await ctx.prisma.product.count()).toBe(1);
    });

    it('records the catalogue product on an order line, and none on a placeholder line', async () => {
      const product = await createProduct(ctx.prisma, { price: '24.50' });
      const customer = await createCustomer(ctx.prisma);

      const real = await createOrder(ctx.prisma, customer, {
        items: [{ product, quantity: 3 }],
      });
      const [line] = await ctx.prisma.orderItem.findMany({
        where: { orderId: real.id },
      });
      expect(line).toMatchObject({
        catalogProductId: product.id,
        productId: `PRD-${product.number}`,
        sku: product.sku,
        quantity: 3,
      });
      expect(line.unitPrice.toString()).toBe('24.5');
      expect(line.total.toString()).toBe('73.5');
      expect(real.total.toString()).toBe('73.5');

      const placeholder = await createOrder(ctx.prisma, customer);
      const [bare] = await ctx.prisma.orderItem.findMany({
        where: { orderId: placeholder.id },
      });
      expect(bare.catalogProductId).toBeNull();
    });

    it("deletes a product's history with the product", async () => {
      const product = await createProduct(ctx.prisma);
      await ctx.prisma.productEvent.create({
        data: { productId: product.id, type: 'CREATED', data: {} },
      });
      await ctx.prisma.product.delete({ where: { id: product.id } });
      expect(await ctx.prisma.productEvent.count()).toBe(0);
    });

    it('keeps history rows when their author is removed', async () => {
      const product = await createProduct(ctx.prisma);
      const user = await createUser(ctx.prisma);
      await ctx.prisma.productEvent.create({
        data: {
          productId: product.id,
          type: 'CREATED',
          data: {},
          actorId: user.id,
        },
      });
      await ctx.prisma.user.delete({ where: { id: user.id } });
      const [event] = await ctx.prisma.productEvent.findMany();
      expect(event.actorId).toBeNull();
    });
  });
});
