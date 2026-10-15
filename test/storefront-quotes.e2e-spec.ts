import request from 'supertest';
import { QuoteTokenService } from '../src/orders/storefront/quote-token.service';
import {
  createProduct,
  createTestApp,
  resetDatabase,
  type ProductOptions,
  type TestContext,
} from './helpers';

jest.setTimeout(30_000);

const LINE_FIELDS = [
  'issue',
  'lineTotal',
  'product',
  'productId',
  'quantity',
  'unitPrice',
];
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

interface Line {
  productId: string;
  quantity: number;
  product: { id: string; name: string; inStock: boolean } | null;
  unitPrice: number | null;
  lineTotal: number | null;
  issue: string | null;
}
interface BagBody {
  currency: string;
  items: Line[];
  subtotal: number;
  lineCount: number;
  unitCount: number;
  hasIssues: boolean;
}
interface CheckoutBody {
  currency: string;
  paymentMethod: string;
  items: Line[];
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  quoteToken: string;
  expiresAt: string;
}

const prd = (product: { number: number }) => `PRD-${product.number}`;
const keysOf = (value: unknown) => Object.keys(value as object).sort();

describe('Storefront bag and checkout quotes (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());
  const bag = (body: object) => http().post('/storefront/bag/quote').send(body);
  const checkout = (body: object) =>
    http().post('/storefront/checkout/quote').send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
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

  /** A product the storefront shows, unless the options say otherwise. */
  const listed = (options: ProductOptions = {}) =>
    createProduct(ctx.prisma, {
      currency: 'PKR',
      price: '1500.00',
      stock: 10,
      ...options,
    });
  const line = (product: { number: number }, quantity: number) => ({
    productId: prd(product),
    quantity,
  });

  const nothingWasWritten = async () => {
    expect(await ctx.prisma.order.count()).toBe(0);
    expect(await ctx.prisma.customer.count()).toBe(0);
    expect(await ctx.prisma.orderEvent.count()).toBe(0);
    expect(await ctx.prisma.productEvent.count()).toBe(0);
  };

  describe('POST /storefront/bag/quote', () => {
    it('answers an anonymous visitor, and an empty bag with zeros', async () => {
      const res = await bag({ items: [] }).expect(200);
      expect(res.body).toEqual({
        currency: 'PKR',
        items: [],
        subtotal: 0,
        lineCount: 0,
        unitCount: 0,
        hasIssues: false,
      });
    });

    it('keeps SQL timings isolated for concurrent bag actions and empty bags', async () => {
      const mug = await listed();
      const [added, incremented, empty] = await Promise.all([
        bag({
          items: [],
          action: { type: 'add', productId: prd(mug) },
        }).expect(200),
        bag({
          items: [line(mug, 1)],
          action: { type: 'increment', productId: prd(mug) },
        }).expect(200),
        bag({ items: [] }).expect(200),
      ]);
      // Count real Prisma query events, including the action's validation read.
      for (const response of [added, incremented]) {
        expect(response.headers['server-timing']).toContain(
          'db_count;desc="1"',
        );
        expect(response.headers['server-timing']).toContain('db_acquire;dur=');
      }
      expect(empty.headers['server-timing']).toContain('db_count;desc="0"');
      expect(
        new Set(
          [added, incremented, empty].map((r) => r.headers['x-request-id']),
        ).size,
      ).toBe(3);
    });

    it('prices every line on the server, exactly, with counts', async () => {
      const kettle = await listed({ name: 'Kettle', price: '199.99' });
      const mug = await listed({ name: 'Mug', price: '0.10' });

      const res = await bag({
        items: [line(kettle, 3), line(mug, 3)],
      }).expect(200);
      const body = res.body as BagBody;

      expect(body.items.map((l) => [l.productId, l.quantity])).toEqual([
        [prd(kettle), 3],
        [prd(mug), 3],
      ]);
      // 199.99 x 3 and 0.10 x 3 are the kind of sums floating point gets wrong.
      expect(body.items.map((l) => l.unitPrice)).toEqual([199.99, 0.1]);
      expect(body.items.map((l) => l.lineTotal)).toEqual([599.97, 0.3]);
      expect(body).toMatchObject({
        currency: 'PKR',
        subtotal: 600.27,
        lineCount: 2,
        unitCount: 6,
        hasIssues: false,
      });
      expect(body.items[0].product).toMatchObject({
        id: prd(kettle),
        name: 'Kettle',
        price: 199.99,
        currency: 'PKR',
        inStock: true,
      });
    });

    it('writes nothing and reserves nothing', async () => {
      const mug = await listed({ stock: 5 });
      await bag({ items: [line(mug, 5)] }).expect(200);
      await nothingWasWritten();
      expect(
        (await ctx.prisma.product.findUniqueOrThrow({ where: { id: mug.id } }))
          .stock,
      ).toBe(5);
    });

    it('exposes only public fields: no stock count, SKU, cost or internal id', async () => {
      const mug = await listed({
        sku: 'HIDDEN-SKU-9',
        costPrice: '321.00',
        stock: 7,
      });
      const res = await bag({ items: [line(mug, 1)] }).expect(200);
      const [item] = (res.body as BagBody).items;
      expect(keysOf(item)).toEqual(LINE_FIELDS);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(mug.id);
      expect(raw).not.toContain('HIDDEN-SKU-9');
      for (const hidden of ['"stock"', '"costPrice"', '"sku"', '"version"']) {
        expect(raw).not.toContain(hidden);
      }
    });

    it('folds the case of ids into one canonical id', async () => {
      const mug = await listed();
      const res = await bag({
        items: [{ productId: prd(mug).toLowerCase(), quantity: 2 }],
      }).expect(200);
      expect((res.body as BagBody).items[0].productId).toBe(prd(mug));
    });

    describe('actions', () => {
      it('adds a product to the end, and merges a repeat into its line', async () => {
        const a = await listed({ name: 'A' });
        const b = await listed({ name: 'B' });

        const added = await bag({
          items: [line(a, 1)],
          action: { type: 'add', productId: prd(b) },
        }).expect(200);
        expect(
          (added.body as BagBody).items.map((l) => [l.productId, l.quantity]),
        ).toEqual([
          [prd(a), 1],
          [prd(b), 1],
        ]);

        const merged = await bag({
          items: [line(a, 1), line(b, 1)],
          action: { type: 'add', productId: prd(a), quantity: 4 },
        }).expect(200);
        expect(
          (merged.body as BagBody).items.map((l) => [l.productId, l.quantity]),
        ).toEqual([
          [prd(a), 5],
          [prd(b), 1],
        ]);
      });

      it('increments, decrements, and drops a line that reaches zero', async () => {
        const a = await listed({ name: 'A' });

        const up = await bag({
          items: [line(a, 2)],
          action: { type: 'increment', productId: prd(a) },
        }).expect(200);
        expect((up.body as BagBody).items[0].quantity).toBe(3);
        expect((up.body as BagBody).subtotal).toBe(4500);
        expect((up.body as BagBody).unitCount).toBe(3);

        const down = await bag({
          items: [line(a, 2)],
          action: { type: 'decrement', productId: prd(a) },
        }).expect(200);
        expect((down.body as BagBody).items[0].quantity).toBe(1);

        const gone = await bag({
          items: [line(a, 1)],
          action: { type: 'decrement', productId: prd(a) },
        }).expect(200);
        expect(gone.body).toMatchObject({
          items: [],
          subtotal: 0,
          lineCount: 0,
          unitCount: 0,
        });
      });

      it('sets an exact quantity and removes a line', async () => {
        const a = await listed({ name: 'A' });
        const b = await listed({ name: 'B' });

        const set = await bag({
          items: [line(a, 1), line(b, 1)],
          action: { type: 'set', productId: prd(a), quantity: 6 },
        }).expect(200);
        expect((set.body as BagBody).items[0].quantity).toBe(6);

        const removed = await bag({
          items: [line(a, 6), line(b, 1)],
          action: { type: 'remove', productId: prd(a) },
        }).expect(200);
        expect((removed.body as BagBody).items.map((l) => l.productId)).toEqual(
          [prd(b)],
        );
      });

      it('is harmless to remove or decrement what is not there', async () => {
        const a = await listed({ name: 'A' });
        const ghost = await listed({ name: 'Ghost' });
        for (const type of ['remove', 'decrement']) {
          const res = await bag({
            items: [line(a, 2)],
            action: { type: type, productId: prd(ghost) },
          }).expect(200);
          expect((res.body as BagBody).items).toHaveLength(1);
        }
      });

      it('refuses an action that would put something unbuyable in the bag, naming why', async () => {
        const fine = await listed({ name: 'Fine', stock: 5 });
        const soldOut = await listed({ name: 'Sold out', stock: 0 });
        const off = await listed({ name: 'Off', status: 'INACTIVE' });

        const sold = await bag({
          items: [],
          action: { type: 'add', productId: prd(soldOut) },
        }).expect(409);
        expect(sold.body).toMatchObject({
          statusCode: 409,
          code: 'INSUFFICIENT_STOCK',
          productId: prd(soldOut),
        });

        const switchedOff = await bag({
          items: [],
          action: { type: 'add', productId: prd(off) },
        }).expect(409);
        expect(switchedOff.body).toMatchObject({
          code: 'PRODUCT_UNAVAILABLE',
          productId: prd(off),
        });
        await bag({
          items: [],
          action: { type: 'add', productId: 'PRD-999999' },
        }).expect(409);

        // Up to the stock is fine; one more is not.
        await bag({
          items: [line(fine, 4)],
          action: { type: 'increment', productId: prd(fine) },
        }).expect(200);
        const over = await bag({
          items: [line(fine, 5)],
          action: { type: 'increment', productId: prd(fine) },
        }).expect(409);
        expect(over.body).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
        // The refusal does not say how many are left.
        expect(JSON.stringify(over.body)).not.toMatch(/available|left|"stock"/);
      });

      it('still lets a shopper take away from a line that has become unbuyable', async () => {
        const a = await listed({ name: 'A', stock: 2 });
        const res = await bag({
          items: [line(a, 9)],
          action: { type: 'decrement', productId: prd(a) },
        }).expect(200);
        const body = res.body as BagBody;
        expect(body.items[0].quantity).toBe(8);
        expect(body.items[0].issue).toBe('INSUFFICIENT_STOCK');
        expect(body.hasIssues).toBe(true);
      });
    });

    describe('lines that cannot be bought as they stand', () => {
      it('flags a product that was switched off, without revealing it', async () => {
        const fine = await listed({ name: 'Fine' });
        const off = await listed({ name: 'Secret name', status: 'INACTIVE' });

        const res = await bag({
          items: [line(fine, 1), line(off, 2)],
        }).expect(200);
        const body = res.body as BagBody;

        expect(body.hasIssues).toBe(true);
        expect(body.items[1]).toEqual({
          productId: prd(off),
          quantity: 2,
          product: null,
          unitPrice: null,
          lineTotal: null,
          issue: 'PRODUCT_UNAVAILABLE',
        });
        // It adds nothing to the subtotal, and its name is not in the response.
        expect(body.subtotal).toBe(1500);
        expect(JSON.stringify(res.body)).not.toContain('Secret name');
      });

      it('flags a quantity beyond the stock, keeping the product visible', async () => {
        const few = await listed({ name: 'Few', stock: 2 });
        const res = await bag({ items: [line(few, 3)] }).expect(200);
        const [item] = (res.body as BagBody).items;
        expect(item.issue).toBe('INSUFFICIENT_STOCK');
        expect(item.product).toMatchObject({ name: 'Few', inStock: true });
        expect(item.lineTotal).toBe(4500);
      });

      it('treats archived, unpriced and unknown products alike', async () => {
        const archived = await listed({ archived: true });
        const free = await listed({ price: '0.00' });
        const res = await bag({
          items: [
            line(archived, 1),
            line(free, 1),
            { productId: 'PRD-999999', quantity: 1 },
          ],
        }).expect(200);
        expect((res.body as BagBody).items.map((l) => l.issue)).toEqual([
          'PRODUCT_UNAVAILABLE',
          'PRODUCT_UNAVAILABLE',
          'PRODUCT_UNAVAILABLE',
        ]);
      });
    });

    describe('currencies', () => {
      const inDollars = (options: ProductOptions = {}) =>
        listed({ currency: 'USD', price: '10.00', ...options });

      it('prices a USD bag in dollars', async () => {
        const a = await inDollars({ name: 'A' });
        const b = await inDollars({ name: 'B', price: '2.50' });
        const res = await bag({
          items: [line(a, 2), line(b, 1)],
        }).expect(200);
        const body = res.body as BagBody;
        expect(body.currency).toBe('USD');
        expect(body.subtotal).toBe(22.5);
        expect(body.hasIssues).toBe(false);
      });

      it('refuses to add a product in another currency than the bag', async () => {
        const rupees = await listed({ name: 'Rupees' });
        const dollars = await inDollars({ name: 'Dollars' });

        const res = await bag({
          items: [line(rupees, 1)],
          action: { type: 'add', productId: prd(dollars) },
        }).expect(409);
        expect(res.body).toMatchObject({
          code: 'CURRENCY_MISMATCH',
          productId: prd(dollars),
        });

        // An empty bag takes either, and the first product sets the currency.
        const first = await bag({
          items: [],
          action: { type: 'add', productId: prd(dollars) },
        }).expect(200);
        expect((first.body as BagBody).currency).toBe('USD');
      });

      it('flags, and does not price, a line in another currency than the first', async () => {
        const rupees = await listed({ name: 'Rupees' });
        const dollars = await inDollars({ name: 'Dollars' });

        const res = await bag({
          items: [line(rupees, 1), line(dollars, 1)],
        }).expect(200);
        const body = res.body as BagBody;
        expect(body.currency).toBe('PKR');
        expect(body.subtotal).toBe(1500);
        expect(body.hasIssues).toBe(true);
        expect(body.items[1]).toMatchObject({
          issue: 'CURRENCY_MISMATCH',
          unitPrice: null,
          lineTotal: null,
        });
        expect(body.items[1].product).toMatchObject({ currency: 'USD' });
      });
    });

    describe('invalid input', () => {
      it('answers INVALID_BAG for a product repeated in the bag, whatever its case', async () => {
        const a = await listed();
        const res = await bag({
          items: [
            { productId: prd(a), quantity: 1 },
            { productId: prd(a).toLowerCase(), quantity: 2 },
          ],
        }).expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          code: 'INVALID_BAG',
        });
      });

      it('answers INVALID_BAG for a quantity past the limit, by merging or by set', async () => {
        const a = await listed({ stock: 5000 });
        const merged = await bag({
          items: [line(a, 1000)],
          action: { type: 'add', productId: prd(a) },
        }).expect(400);
        expect(merged.body).toMatchObject({ code: 'INVALID_BAG' });

        await bag({
          items: [],
          action: { type: 'set', productId: prd(a) },
        })
          .expect(400)
          .expect((r) => expect(r.body.code).toBe('INVALID_BAG'));
        await bag({
          items: [line(a, 1)],
          action: { type: 'remove', productId: prd(a), quantity: 1 },
        })
          .expect(400)
          .expect((r) => expect(r.body.code).toBe('INVALID_BAG'));
      });

      it('answers INVALID_BAG for a 101st product', async () => {
        const items = Array.from({ length: 101 }, (_, i) => ({
          productId: `PRD-${5000 + i}`,
          quantity: 1,
        }));
        const res = await bag({ items }).expect(400);
        expect(res.body).toMatchObject({ code: 'INVALID_BAG' });
      });

      it('refuses prices, totals and anything else the client might send', async () => {
        const a = await listed();
        await bag({
          items: [{ productId: prd(a), quantity: 1, price: 1 }],
        }).expect(400);
        await bag({ items: [line(a, 1)], total: 1 }).expect(400);
        await bag({ items: [line(a, 1)], currency: 'USD' }).expect(400);
        await bag({}).expect(400);
        await bag({ items: [{ productId: 'nope', quantity: 1 }] }).expect(400);
        await bag({ items: [line(a, 0)] }).expect(400);
      });

      it('answers ORDER_TOO_LARGE for a bag no order could record', async () => {
        const made = [];
        for (let i = 0; i < 10; i++) {
          made.push(
            await listed({
              sku: `BIG-${i}`,
              price: '1000000.00',
              stock: 1000,
            }),
          );
        }
        // 10 lines x 1000 units x 1,000,000 = 10,000,000,000 > 9,999,999,999.99
        const res = await bag({
          items: made.map((p) => line(p, 1000)),
        }).expect(400);
        expect(res.body).toMatchObject({ code: 'ORDER_TOO_LARGE' });

        // Nine such lines are the largest that fit.
        await bag({ items: made.slice(0, 9).map((p) => line(p, 1000)) }).expect(
          200,
        );
      });
    });
  });

  describe('POST /storefront/checkout/quote', () => {
    it('prices the bag with zero demo charges, in PKR, for cash on delivery', async () => {
      const kettle = await listed({ name: 'Kettle', price: '199.99' });
      const mug = await listed({ name: 'Mug', price: '0.10' });

      const res = await checkout({
        items: [line(kettle, 3), line(mug, 3)],
        shippingAddress: ADDRESS,
      }).expect(200);
      const body = res.body as CheckoutBody;

      expect(body).toMatchObject({
        currency: 'PKR',
        paymentMethod: 'COD',
        subtotal: 600.27,
        shipping: 0,
        tax: 0,
        discount: 0,
        total: 600.27,
      });
      expect(body.items.map((l) => l.lineTotal)).toEqual([599.97, 0.3]);
      expect(typeof body.quoteToken).toBe('string');
      expect(body.quoteToken.length).toBeGreaterThan(20);
    });

    it('is a quote only: no customer, order, reservation or history', async () => {
      const mug = await listed({ stock: 3 });
      await checkout({
        items: [line(mug, 3)],
        shippingAddress: ADDRESS,
      }).expect(200);
      await nothingWasWritten();
      expect(
        (await ctx.prisma.product.findUniqueOrThrow({ where: { id: mug.id } }))
          .stock,
      ).toBe(3);
    });

    it('issues a signed token that binds the items, prices, destination and amounts', async () => {
      const a = await listed({ name: 'A', price: '100.00' });
      const b = await listed({ name: 'B', price: '250.50' });

      const res = await checkout({
        // Listed in the opposite order to their ids.
        items: [line(b, 1), line(a, 2)],
        shippingAddress: {
          ...ADDRESS,
          region: '  Islamabad   Capital Territory ',
        },
      }).expect(200);
      const body = res.body as CheckoutBody;

      const tokens = ctx.app.get(QuoteTokenService);
      const verified = tokens.verify(body.quoteToken);
      expect(verified.status).toBe('valid');
      if (verified.status !== 'valid') return;
      expect(verified.claims).toEqual({
        currency: 'PKR',
        items: [
          [a.number, 2],
          [b.number, 1],
        ],
        unitPrices: ['100.00', '250.50'],
        destination: { country: 'PK', region: 'islamabad capital territory' },
        subtotal: '450.50',
        shipping: '0.00',
        tax: '0.00',
        discount: '0.00',
        total: '450.50',
      });
      expect(verified.expiresAt.toISOString()).toBe(body.expiresAt);
      const minutes = (verified.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);
    });

    it('binds the same items however the bag is ordered', async () => {
      const a = await listed({ name: 'A' });
      const b = await listed({ name: 'B' });
      const tokens = ctx.app.get(QuoteTokenService);
      const claimsFor = async (items: object[]) => {
        const res = await checkout({ items, shippingAddress: ADDRESS }).expect(
          200,
        );
        const v = tokens.verify((res.body as CheckoutBody).quoteToken);
        return v.status === 'invalid' ? null : v.claims;
      };
      expect(await claimsFor([line(a, 1), line(b, 2)])).toEqual(
        await claimsFor([line(b, 2), line(a, 1)]),
      );
    });

    it('accepts "Pakistan" as the country, and refuses another destination', async () => {
      const mug = await listed();
      await checkout({
        items: [line(mug, 1)],
        shippingAddress: { ...ADDRESS, country: 'Pakistan' },
      }).expect(200);

      for (const country of ['US', 'India', 'United Kingdom']) {
        const res = await checkout({
          items: [line(mug, 1)],
          shippingAddress: { ...ADDRESS, country },
        }).expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          code: 'UNSUPPORTED_DESTINATION',
        });
      }
    });

    it('requires a complete Pakistan address', async () => {
      const mug = await listed();
      const send = (shippingAddress: object) =>
        checkout({ items: [line(mug, 1)], shippingAddress });

      await send({ ...ADDRESS, region: '' }).expect(400);
      await send({ ...ADDRESS, city: '' }).expect(400);
      await send({ ...ADDRESS, addressLine1: '' }).expect(400);
      await send({ ...ADDRESS, recipientName: '' }).expect(400);
      await send({ ...ADDRESS, postalCode: '123' }).expect(400);
      await send({ ...ADDRESS, phone: '+1 415 555 0100' }).expect(400);
      // The optional ones may be left out.
      const minimal = { ...ADDRESS };
      delete (minimal as Record<string, unknown>).phone;
      delete (minimal as Record<string, unknown>).postalCode;
      delete (minimal as Record<string, unknown>).addressLine2;
      await send(minimal).expect(200);
    });

    it('needs at least one line', async () => {
      await checkout({ items: [], shippingAddress: ADDRESS }).expect(400);
    });

    it('refuses amounts, charges and a currency from the client', async () => {
      const mug = await listed();
      for (const extra of [
        { shipping: 0 },
        { tax: 0 },
        { discount: 500 },
        { total: 1 },
        { currency: 'USD' },
        { paymentMethod: 'CARD' },
        { quoteToken: 'x' },
      ]) {
        await checkout({
          items: [line(mug, 1)],
          shippingAddress: ADDRESS,
          ...extra,
        }).expect(400);
      }
    });

    it('refuses a bag with a line that cannot be bought, and says which', async () => {
      const fine = await listed({ name: 'Fine' });
      const off = await listed({ status: 'INACTIVE' });
      const few = await listed({ stock: 1 });

      const unavailable = await checkout({
        items: [line(fine, 1), line(off, 1)],
        shippingAddress: ADDRESS,
      }).expect(409);
      expect(unavailable.body).toMatchObject({
        statusCode: 409,
        code: 'PRODUCT_UNAVAILABLE',
        issues: [{ productId: prd(off), issue: 'PRODUCT_UNAVAILABLE' }],
      });

      const short = await checkout({
        items: [line(fine, 1), line(few, 2)],
        shippingAddress: ADDRESS,
      }).expect(409);
      expect(short.body).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        issues: [{ productId: prd(few), issue: 'INSUFFICIENT_STOCK' }],
      });
      expect(JSON.stringify(short.body)).not.toMatch(/"stock"|available/);
      expect(short.body.quoteToken).toBeUndefined();
    });

    it('quotes a USD bag in dollars, and refuses a bag that mixes currencies', async () => {
      const dollars = await listed({ currency: 'USD', price: '10.00' });
      const rupees = await listed({ name: 'Rupees' });

      const quoted = await checkout({
        items: [line(dollars, 3)],
        shippingAddress: ADDRESS,
      }).expect(200);
      expect(quoted.body).toMatchObject({
        currency: 'USD',
        subtotal: 30,
        total: 30,
      });

      const mixed = await checkout({
        items: [line(dollars, 1), line(rupees, 1)],
        shippingAddress: ADDRESS,
      }).expect(409);
      expect(mixed.body).toMatchObject({
        code: 'CURRENCY_MISMATCH',
        issues: [{ productId: prd(rupees), issue: 'CURRENCY_MISMATCH' }],
      });
      expect(mixed.body.quoteToken).toBeUndefined();
    });

    it('answers INVALID_BAG for a repeated product and ORDER_TOO_LARGE for a huge bag', async () => {
      const a = await listed();
      const repeated = await checkout({
        items: [line(a, 1), line(a, 2)],
        shippingAddress: ADDRESS,
      }).expect(400);
      expect(repeated.body).toMatchObject({ code: 'INVALID_BAG' });

      const made = [];
      for (let i = 0; i < 10; i++) {
        made.push(
          await listed({ sku: `BIG-${i}`, price: '1000000.00', stock: 1000 }),
        );
      }
      const huge = await checkout({
        items: made.map((p) => line(p, 1000)),
        shippingAddress: ADDRESS,
      }).expect(400);
      expect(huge.body).toMatchObject({ code: 'ORDER_TOO_LARGE' });
    });

    it('prices from the products as they are now, not as an earlier quote saw them', async () => {
      const mug = await listed({ price: '100.00' });
      const first = await checkout({
        items: [line(mug, 1)],
        shippingAddress: ADDRESS,
      }).expect(200);
      await ctx.prisma.product.update({
        where: { id: mug.id },
        data: { price: '120.00' },
      });
      const second = await checkout({
        items: [line(mug, 1)],
        shippingAddress: ADDRESS,
      }).expect(200);
      expect((first.body as CheckoutBody).total).toBe(100);
      expect((second.body as CheckoutBody).total).toBe(120);
      expect((second.body as CheckoutBody).quoteToken).not.toBe(
        (first.body as CheckoutBody).quoteToken,
      );
    });
  });
});
