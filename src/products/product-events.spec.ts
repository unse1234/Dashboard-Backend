import { Prisma } from '../generated/prisma/client';
import {
  describeEvent,
  diffProduct,
  toEventRows,
  type ProductSnapshot,
} from './product-events';

const base: ProductSnapshot = {
  name: 'Ceramic Mug',
  sku: 'MUG-001',
  subtitle: null,
  brand: 'Hearthstone',
  description: 'Holds 350 ml.',
  imageUrl: null,
  galleryUrls: [],
  categoryId: 'cat-1',
  status: 'ACTIVE',
  price: new Prisma.Decimal('12.50'),
  currency: 'USD',
  costPrice: new Prisma.Decimal('4.25'),
  stock: 10,
};

describe('diffProduct', () => {
  it('finds nothing when nothing changed', () => {
    expect(diffProduct(base, { ...base })).toEqual([]);
  });

  it('treats equal amounts as equal whatever their scale', () => {
    expect(
      diffProduct(base, {
        ...base,
        price: new Prisma.Decimal('12.5'),
        costPrice: new Prisma.Decimal('4.250'),
      }),
    ).toEqual([]);
  });

  it('records every changed detail in one event, in a fixed order', () => {
    expect(
      diffProduct(base, {
        ...base,
        categoryId: 'cat-2',
        name: 'Stoneware Mug',
        brand: null,
        sku: 'MUG-002',
        description: null,
      }),
    ).toEqual([
      {
        type: 'DETAILS_UPDATED',
        data: {
          fields: ['name', 'sku', 'brand', 'description', 'category'],
        },
      },
    ]);
  });

  it('records the selling price and the cost price as separate events', () => {
    expect(
      diffProduct(base, {
        ...base,
        price: new Prisma.Decimal('14.00'),
        costPrice: null,
      }),
    ).toEqual([
      {
        type: 'PRICE_CHANGED',
        data: { field: 'price', from: 12.5, to: 14, currency: 'USD' },
      },
      {
        type: 'PRICE_CHANGED',
        data: { field: 'costPrice', from: 4.25, to: null, currency: 'USD' },
      },
    ]);
  });

  it('records a changed subtitle and changed images as details', () => {
    expect(
      diffProduct(base, {
        ...base,
        subtitle: 'Holds 350 ml',
        imageUrl: '/products/mug.png',
      }),
    ).toEqual([
      {
        type: 'DETAILS_UPDATED',
        data: { fields: ['subtitle', 'images'] },
      },
    ]);
  });

  it('sees a gallery that was reordered or extended', () => {
    const before = { ...base, galleryUrls: ['/a.png', '/b.png'] };
    expect(
      diffProduct(before, { ...before, galleryUrls: ['/b.png', '/a.png'] }),
    ).toHaveLength(1);
    expect(
      diffProduct(before, { ...before, galleryUrls: ['/a.png'] }),
    ).toHaveLength(1);
    expect(diffProduct(before, { ...before })).toEqual([]);
  });

  it('records a currency change as a price change, even at the same amount', () => {
    expect(diffProduct(base, { ...base, currency: 'PKR' })).toEqual([
      {
        type: 'PRICE_CHANGED',
        data: {
          field: 'price',
          from: 12.5,
          to: 12.5,
          currency: 'PKR',
          fromCurrency: 'USD',
        },
      },
      {
        type: 'PRICE_CHANGED',
        data: {
          field: 'costPrice',
          from: 4.25,
          to: 4.25,
          currency: 'PKR',
          fromCurrency: 'USD',
        },
      },
    ]);
  });

  it('does not record a cost price that neither side has when the currency changes', () => {
    const events = diffProduct(
      { ...base, costPrice: null },
      { ...base, costPrice: null, currency: 'PKR' },
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ field: 'price' });
  });

  it('sees a cost price being set for the first time', () => {
    expect(
      diffProduct(
        { ...base, costPrice: null },
        { ...base, costPrice: new Prisma.Decimal('0') },
      ),
    ).toEqual([
      {
        type: 'PRICE_CHANGED',
        data: { field: 'costPrice', from: null, to: 0, currency: 'USD' },
      },
    ]);
  });

  it('records status and stock changes, stock as a manual change', () => {
    expect(
      diffProduct(base, { ...base, status: 'INACTIVE', stock: 0 }),
    ).toEqual([
      { type: 'STATUS_CHANGED', data: { from: 'ACTIVE', to: 'INACTIVE' } },
      {
        type: 'STOCK_CHANGED',
        data: { from: 10, to: 0, reason: 'MANUAL' },
      },
    ]);
  });
});

describe('toEventRows', () => {
  it('attaches the product and the author to every event', () => {
    expect(
      toEventRows('p1', 'u1', [
        { type: 'CREATED', data: {} },
        { type: 'ARCHIVED', data: {} },
      ]),
    ).toEqual([
      { productId: 'p1', actorId: 'u1', type: 'CREATED', data: {} },
      { productId: 'p1', actorId: 'u1', type: 'ARCHIVED', data: {} },
    ]);
  });

  it('records automatic changes without an author', () => {
    const [row] = toEventRows('p1', null, [
      {
        type: 'STOCK_CHANGED',
        data: { from: 5, to: 4, reason: 'ORDER_PLACED', orderNumber: 10002 },
      },
    ]);
    expect(row.actorId).toBeNull();
  });
});

describe('describeEvent', () => {
  it.each([
    ['CREATED', {}, 'Product created'],
    ['ARCHIVED', {}, 'Product archived'],
    [
      'PRICE_CHANGED',
      { field: 'price', from: 269, to: 249 },
      'Price changed from $269.00 to $249.00',
    ],
    [
      'PRICE_CHANGED',
      { field: 'costPrice', from: null, to: 17.2 },
      'Cost price changed from Not set to $17.20',
    ],
    [
      'PRICE_CHANGED',
      { field: 'costPrice', from: 17.2, to: null },
      'Cost price changed from $17.20 to Not set',
    ],
    [
      'STOCK_CHANGED',
      { from: 96, to: 184, reason: 'MANUAL' },
      'Stock updated from 96 to 184',
    ],
    [
      'STOCK_CHANGED',
      { from: 880, to: 1240, reason: 'MANUAL' },
      'Stock updated from 880 to 1,240',
    ],
    [
      'STOCK_CHANGED',
      { from: 10, to: 8, reason: 'ORDER_PLACED', orderNumber: 10002 },
      'Stock reduced from 10 to 8 by order ORD-10002',
    ],
    [
      'STOCK_CHANGED',
      { from: 8, to: 10, reason: 'ORDER_CANCELLED', orderNumber: 10002 },
      'Stock restored from 8 to 10 (order ORD-10002 cancelled)',
    ],
    [
      'STATUS_CHANGED',
      { from: 'ACTIVE', to: 'INACTIVE' },
      'Status changed from Active to Inactive',
    ],
    [
      'DETAILS_UPDATED',
      { fields: ['name', 'sku', 'category'] },
      'Details updated: name, SKU, category',
    ],
    [
      'DETAILS_UPDATED',
      { fields: ['subtitle', 'images'] },
      'Details updated: subtitle, images',
    ],
    [
      'PRICE_CHANGED',
      { field: 'price', from: 2800, to: 2600, currency: 'PKR' },
      'Price changed from PKR 2,800.00 to PKR 2,600.00',
    ],
    [
      'PRICE_CHANGED',
      {
        field: 'price',
        from: 10,
        to: 2800,
        currency: 'PKR',
        fromCurrency: 'USD',
      },
      'Price changed from $10.00 to PKR 2,800.00',
    ],
  ] as const)('phrases %s %j', (type, data, text) => {
    expect(describeEvent(type, data)).toBe(text);
  });

  it('still reads sensibly when the stored data is not what was expected', () => {
    expect(describeEvent('DETAILS_UPDATED', null)).toBe('Details updated');
    expect(describeEvent('DETAILS_UPDATED', { fields: ['constructor'] })).toBe(
      'Details updated',
    );
    expect(describeEvent('DETAILS_UPDATED', { fields: 'name' })).toBe(
      'Details updated',
    );
    expect(describeEvent('PRICE_CHANGED', [])).toBe(
      'Price changed from Not set to Not set',
    );
    expect(describeEvent('STOCK_CHANGED', { reason: 'ORDER_PLACED' })).toBe(
      'Stock reduced from ? to ? by an order',
    );
    expect(describeEvent('STATUS_CHANGED', { from: 'X', to: 7 })).toBe(
      'Status changed from Unknown to Unknown',
    );
  });
});
