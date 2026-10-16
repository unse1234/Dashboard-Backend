import request from 'supertest';
import {
  bearer,
  createProduct,
  createTestApp,
  createUser,
  getCategory,
  login,
  resetDatabase,
  type ProductOptions,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

const PRODUCT_FIELDS = [
  'brand',
  'category',
  'currency',
  'description',
  'gallery',
  'id',
  'image',
  'inStock',
  'name',
  'price',
  'subtitle',
];

interface PublicProduct {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  category: { id: string; name: string };
  price: number;
  currency: string;
  image: { url: string; alt: string } | null;
  gallery: { url: string; alt: string }[];
  inStock: boolean;
}

interface Page {
  data: PublicProduct[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const keysOf = (value: unknown) => Object.keys(value as object).sort();
const prd = (product: { number: number }) => `PRD-${product.number}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

describe('Storefront catalogue (e2e)', () => {
  let ctx: TestContext;
  let staffToken: string;
  const http = () => request(ctx.app.getHttpServer());
  // Anonymous: no Authorization header at all.
  const visit = (path: string) => http().get(path);
  const idsOf = (res: { body: unknown }) =>
    (res.body as Page).data.map((p) => p.id);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, {
      email: 'staff@example.com',
      name: 'Sam Staff',
      role: 'STAFF',
    });
    staffToken = (await login(ctx.app, 'staff@example.com')).accessToken;
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProductEvent", "OrderEvent", "OrderItem", "Order", "Product"',
    );
  });

  /** A product the storefront shows, unless the options say otherwise. */
  const listed = (options: ProductOptions = {}) =>
    createProduct(ctx.prisma, {
      currency: 'PKR',
      price: '1500.00',
      ...options,
    });

  describe('access', () => {
    it('lets an anonymous visitor read the catalogue and a product', async () => {
      const product = await listed();
      const list = await visit('/storefront/products').expect(200);
      expect(idsOf(list)).toEqual([prd(product)]);
      await visit(`/storefront/products/${prd(product)}`).expect(200);
    });

    it('keeps every dashboard route behind authentication', async () => {
      const product = await listed();
      for (const path of [
        '/products',
        `/products/${prd(product)}`,
        `/products/${prd(product)}/history`,
        '/categories',
        '/orders',
        '/orders/ORD-1001',
        '/customers',
        '/customers/CUS-1001',
        '/storefront/catalog-readiness',
      ]) {
        await visit(path).expect(401);
      }
      await http().post('/orders').send({}).expect(401);
      await http().post('/products').send({}).expect(401);
      await http().post('/products/archive').send({}).expect(401);
      await http()
        .patch(`/products/${prd(product)}`)
        .send({})
        .expect(401);
    });

    it('offers no way to write through the public routes', async () => {
      const product = await listed();
      await http().post('/storefront/products').send({}).expect(404);
      await http()
        .patch(`/storefront/products/${prd(product)}`)
        .send({ price: 1 })
        .expect(404);
      await http()
        .delete(`/storefront/products/${prd(product)}`)
        .expect(404);
    });
  });

  describe('what is visible', () => {
    it('shows active, unarchived, priced products, sold out ones included', async () => {
      const inStock = await listed({ name: 'In stock', stock: 5 });
      const soldOut = await listed({ name: 'Sold out', stock: 0 });
      await listed({ name: 'Switched off', status: 'INACTIVE' });
      await listed({ name: 'Archived', archived: true });
      await listed({ name: 'No price', price: '0.00' });

      const res = await visit('/storefront/products?sort=name').expect(200);
      expect(idsOf(res).sort()).toEqual([prd(inStock), prd(soldOut)].sort());
      const byName = Object.fromEntries(
        (res.body as Page).data.map((p) => [p.name, p]),
      );
      expect(byName['In stock'].inStock).toBe(true);
      expect(byName['Sold out'].inStock).toBe(false);
      expect((res.body as Page).meta.total).toBe(2);
    });

    it('shows only PKR products and hides legacy USD prices from new sales', async () => {
      const rupees = await listed({ name: 'In rupees' });
      const dollars = await createProduct(ctx.prisma, {
        name: 'In dollars',
        currency: 'USD',
        price: '10.00',
      });
      const res = await visit('/storefront/products?sort=name').expect(200);
      const byId = Object.fromEntries(
        (res.body as Page).data.map((p) => [p.id, p]),
      );
      expect(Object.keys(byId).sort()).toEqual([prd(rupees)]);
      expect(byId[prd(dollars)]).toBeUndefined();
      expect(byId[prd(rupees)]).toMatchObject({ price: 1500, currency: 'PKR' });
      await visit(`/storefront/products/${prd(dollars)}`).expect(404);
    });
  });

  describe('the projection', () => {
    it('has exactly the public fields, and none of the internal ones', async () => {
      const product = await listed({
        name: 'Wireless Headphones',
        sku: 'HIDDEN-SKU-77',
        subtitle: 'Noise cancelling',
        description: 'Over-ear.',
        brand: 'Aural',
        costPrice: '777.00',
        stock: 31,
        imageUrl: 'https://cdn.example.com/h1.jpg',
        galleryUrls: ['/products/h2.png', '/products/h3.png'],
        category: 'Electronics',
      });
      const category = await getCategory(ctx.prisma, 'Electronics');

      const res = await visit(`/storefront/products/${prd(product)}`).expect(
        200,
      );
      const body = res.body as PublicProduct;
      expect(keysOf(body)).toEqual(PRODUCT_FIELDS);
      expect(keysOf(body.category)).toEqual(['id', 'name']);
      expect(body).toEqual({
        id: prd(product),
        name: 'Wireless Headphones',
        subtitle: 'Noise cancelling',
        description: 'Over-ear.',
        brand: 'Aural',
        category: { id: category.id, name: 'Electronics' },
        price: 1500,
        currency: 'PKR',
        image: {
          url: 'https://cdn.example.com/h1.jpg',
          alt: 'Wireless Headphones',
        },
        gallery: [
          { url: '/products/h2.png', alt: 'Wireless Headphones, view 2' },
          { url: '/products/h3.png', alt: 'Wireless Headphones, view 3' },
        ],
        inStock: true,
      });

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(product.id); // the internal uuid
      expect(raw).not.toContain('HIDDEN-SKU-77');
      for (const hidden of ['costPrice', 'stock', 'version', 'sku', 'status']) {
        expect(raw).not.toContain(`"${hidden}"`);
      }
    });

    it('has the same fields in the list, and null where there is no image', async () => {
      await listed({ name: 'Plain' });
      const res = await visit('/storefront/products').expect(200);
      const [item] = (res.body as Page).data;
      expect(keysOf(item)).toEqual(PRODUCT_FIELDS);
      expect(item).toMatchObject({
        subtitle: null,
        description: null,
        brand: null,
        image: null,
        gallery: [],
      });
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await listed({
        name: 'Ceramic Mug',
        subtitle: 'Hand glazed',
        brand: 'Hearthstone',
        sku: 'FIND-ME-SKU',
      });
      await listed({ name: '100% Cotton Towel', brand: 'Loom' });
      await listed({ name: 'Under_score Lamp', brand: 'Glow' });
      await listed({ name: 'Standing Desk', brand: 'Hearthstone' });
    });

    const search = async (term: string) =>
      (
        (
          await visit(
            `/storefront/products?search=${encodeURIComponent(term)}`,
          ).expect(200)
        ).body as Page
      ).data.map((p) => p.name);

    it('matches name, subtitle and brand, ignoring case', async () => {
      expect(await search('ceramic')).toEqual(['Ceramic Mug']);
      expect(await search('GLAZED')).toEqual(['Ceramic Mug']);
      expect((await search('hearthstone')).sort()).toEqual([
        'Ceramic Mug',
        'Standing Desk',
      ]);
    });

    it('ignores surrounding spaces', async () => {
      expect(await search('   towel   ')).toEqual(['100% Cotton Towel']);
    });

    it('treats % and _ literally', async () => {
      expect(await search('%')).toEqual(['100% Cotton Towel']);
      expect(await search('_')).toEqual(['Under_score Lamp']);
      expect(await search('100%')).toEqual(['100% Cotton Towel']);
      expect(await search('c_t')).toEqual([]);
    });

    it('does not search what the projection hides', async () => {
      expect(await search('FIND-ME-SKU')).toEqual([]);
      expect(await search('PRD-1001')).toEqual([]);
    });

    it('returns an empty page, with true totals, when nothing matches', async () => {
      const res = await visit('/storefront/products?search=zzzz').expect(200);
      expect(res.body).toEqual({
        data: [],
        meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
      });
    });

    it('does not let a search reveal a product the catalogue hides', async () => {
      await listed({ name: 'Secret Archived Gadget', archived: true });
      await listed({ name: 'Secret Inactive Gadget', status: 'INACTIVE' });
      expect(await search('secret')).toEqual([]);
    });
  });

  describe('category filter', () => {
    it('narrows to one category, and to nothing for an unused one', async () => {
      const mug = await listed({ name: 'Mug', category: 'Home & Kitchen' });
      await listed({ name: 'Phone', category: 'Electronics' });
      const home = await getCategory(ctx.prisma, 'Home & Kitchen');
      const sports = await getCategory(ctx.prisma, 'Sports & Outdoors');

      const only = await visit(
        `/storefront/products?categoryId=${home.id}`,
      ).expect(200);
      expect(idsOf(only)).toEqual([prd(mug)]);

      const none = await visit(
        `/storefront/products?categoryId=${sports.id}`,
      ).expect(200);
      expect((none.body as Page).data).toEqual([]);
    });

    it('combines with search', async () => {
      await listed({ name: 'Glass Mug', category: 'Home & Kitchen' });
      await listed({ name: 'Phone Mug Holder', category: 'Electronics' });
      const home = await getCategory(ctx.prisma, 'Home & Kitchen');
      const res = await visit(
        `/storefront/products?categoryId=${home.id}&search=mug`,
      ).expect(200);
      expect((res.body as Page).data.map((p) => p.name)).toEqual(['Glass Mug']);
    });
  });

  describe('sorting', () => {
    let cheap: { number: number };
    let middle: { number: number };
    let dear: { number: number };

    beforeEach(async () => {
      middle = await listed({
        name: 'bravo',
        price: '200.00',
        createdAt: daysAgo(2),
      });
      dear = await listed({
        name: 'Charlie',
        price: '300.00',
        createdAt: daysAgo(1),
      });
      cheap = await listed({
        name: 'Alpha',
        price: '100.00',
        createdAt: daysAgo(3),
      });
    });

    const order = async (sort?: string) =>
      idsOf(
        await visit(
          `/storefront/products${sort ? `?sort=${sort}` : ''}`,
        ).expect(200),
      );

    it('puts the newest first by default', async () => {
      expect(await order()).toEqual([prd(dear), prd(middle), prd(cheap)]);
      expect(await order('newest')).toEqual(await order());
    });

    it('sorts by price in both directions', async () => {
      expect(await order('price_asc')).toEqual([
        prd(cheap),
        prd(middle),
        prd(dear),
      ]);
      expect(await order('price_desc')).toEqual([
        prd(dear),
        prd(middle),
        prd(cheap),
      ]);
    });

    it('sorts by name without regard to case', async () => {
      // "Alpha", "bravo", "Charlie": a byte-wise sort would put "bravo" last.
      expect(await order('name')).toEqual([prd(cheap), prd(middle), prd(dear)]);
    });

    it('keeps pages stable when many products tie on the sort key', async () => {
      await ctx.prisma.$executeRawUnsafe('TRUNCATE TABLE "Product" CASCADE');
      const sameMoment = daysAgo(1);
      const made = [];
      for (let i = 0; i < 7; i++) {
        made.push(
          await listed({
            name: 'Twin',
            price: '50.00',
            createdAt: sameMoment,
          }),
        );
      }
      for (const sort of ['newest', 'price_asc', 'price_desc', 'name']) {
        const seen: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const res = await visit(
            `/storefront/products?sort=${sort}&pageSize=2&page=${page}`,
          ).expect(200);
          seen.push(...idsOf(res));
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
        expect([...seen].sort()).toEqual(made.map(prd).sort());
      }
    });
  });

  describe('pagination', () => {
    it('reports the page, its size and the true totals', async () => {
      for (let i = 0; i < 5; i++) await listed({ name: `P${i}` });
      const res = await visit('/storefront/products?pageSize=2&page=2').expect(
        200,
      );
      expect((res.body as Page).meta).toEqual({
        page: 2,
        pageSize: 2,
        total: 5,
        totalPages: 3,
      });
      expect((res.body as Page).data).toHaveLength(2);
    });

    it('defaults to 20 a page', async () => {
      const res = await visit('/storefront/products').expect(200);
      expect((res.body as Page).meta).toMatchObject({
        page: 1,
        pageSize: 20,
      });
    });

    it('returns an empty page, with the true totals, past the end', async () => {
      await listed();
      await listed({ name: 'Another' });
      const res = await visit('/storefront/products?page=9').expect(200);
      expect(res.body).toEqual({
        data: [],
        meta: { page: 9, pageSize: 20, total: 2, totalPages: 1 },
      });
    });

    it('accepts the largest page size and the deepest page', async () => {
      await visit('/storefront/products?pageSize=100').expect(200);
      await visit('/storefront/products?page=10000').expect(200);
    });
  });

  describe('invalid parameters', () => {
    it.each([
      'page=0',
      'page=-1',
      'page=abc',
      'page=10001',
      'pageSize=0',
      'pageSize=101',
      'sort=costPrice',
      'sort=price',
      'categoryId=Electronics',
      'categoryId=',
      `search=${'a'.repeat(101)}`,
      // No client-selected visibility or status filter is accepted.
      'status=INACTIVE',
      'archived=true',
      'currency=USD',
      'includeArchived=1',
      'sortBy=price',
    ])('answers 400 for ?%s', async (qs) => {
      await listed();
      await visit(`/storefront/products?${qs}`).expect(400);
    });
  });

  describe('GET /storefront/products/:productId', () => {
    it('shows a sold-out product as not in stock', async () => {
      const product = await listed({ stock: 0 });
      const res = await visit(`/storefront/products/${prd(product)}`).expect(
        200,
      );
      expect((res.body as PublicProduct).inStock).toBe(false);
    });

    it('answers the same 404 whatever the reason the product is not shown', async () => {
      const inactive = await listed({ status: 'INACTIVE' });
      const archived = await listed({ archived: true });
      const free = await listed({ price: '0.00' });

      const bodies = [];
      for (const id of [
        'PRD-999999',
        'PRD-0',
        'abc',
        'PRD-1001-extra',
        '1001',
        prd(inactive),
        prd(archived),
        prd(free),
      ]) {
        const res = await visit(
          `/storefront/products/${encodeURIComponent(id)}`,
        ).expect(404);
        bodies.push(res.body);
      }
      for (const body of bodies) expect(body).toEqual(bodies[0]);
    });
  });

  describe('GET /storefront/catalog-readiness', () => {
    it('is for staff only', async () => {
      await visit('/storefront/catalog-readiness').expect(401);
      await http()
        .get('/storefront/catalog-readiness')
        .set(bearer(staffToken))
        .expect(200);
    });

    it('names the active products the storefront is hiding, and counts the rest', async () => {
      await listed({ name: 'Shown 1' });
      await listed({ name: 'Shown 2', stock: 0 });
      const dollars = await createProduct(ctx.prisma, {
        name: 'In dollars',
        currency: 'USD',
        price: '10.00',
      });
      const free = await listed({ name: 'Unpriced', price: '0.00' });
      await listed({ name: 'Off', status: 'INACTIVE' });
      await listed({ name: 'Gone', archived: true });

      const res = await http()
        .get('/storefront/catalog-readiness')
        .set(bearer(staffToken))
        .expect(200);
      expect(res.body).toEqual({
        eligible: 2,
        excludedCount: 2,
        excluded: [
          { id: prd(dollars), name: 'In dollars', currency: 'USD', price: 10 },
          { id: prd(free), name: 'Unpriced', currency: 'PKR', price: 0 },
        ],
      });
    });
  });
});
