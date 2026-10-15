import type { PrismaService } from '../../prisma/prisma.service';
import type { StorefrontStockedProductRow } from '../../products/storefront/storefront-catalog';
import type { BagQuoteDto } from './dto/bag-quote.dto';
import type { QuoteTokenService } from './quote-token.service';
import { StorefrontPricingService } from './storefront-pricing.service';
import { StorefrontQuoteService } from './storefront-quote.service';

function product(
  number: number,
  overrides: Partial<StorefrontStockedProductRow> = {},
): StorefrontStockedProductRow {
  return {
    number,
    name: `Product ${number}`,
    subtitle: null,
    description: null,
    brand: null,
    imageUrl: null,
    galleryUrls: [],
    price: '199.99',
    currency: 'PKR',
    inStock: true,
    stock: 10,
    categoryId: 'category-id',
    categoryName: 'Kitchen',
    ...overrides,
  };
}

describe('StorefrontQuoteService bag pricing', () => {
  const read = jest.fn<Promise<StorefrontStockedProductRow[]>, unknown[]>();
  const pricing = new StorefrontPricingService({
    $queryRaw: read,
  } as unknown as PrismaService);
  const quotes = new StorefrontQuoteService(pricing, {} as QuoteTokenService);

  beforeEach(() => {
    read.mockReset();
  });

  it.each(['add', 'increment', 'set'] as const)(
    'reads products once to validate and price a successful %s',
    async (type) => {
      read.mockResolvedValue([product(1001)]);

      const result = await quotes.quoteBag({
        items: [{ productId: 'PRD-1001', quantity: 2 }],
        action: {
          type,
          productId: 'PRD-1001',
          ...(type === 'set' ? { quantity: 3 } : {}),
        },
      });

      expect(read).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        currency: 'PKR',
        subtotal: 599.97,
        lineCount: 1,
        unitCount: 3,
        hasIssues: false,
        items: [
          {
            productId: 'PRD-1001',
            quantity: 3,
            unitPrice: 199.99,
            lineTotal: 599.97,
            issue: null,
            product: { id: 'PRD-1001', currency: 'PKR' },
          },
        ],
      });
      expect(Object.keys(result.items[0]).sort()).toEqual([
        'issue',
        'lineTotal',
        'product',
        'productId',
        'quantity',
        'unitPrice',
      ]);
    },
  );

  it('adds a new line at the end and uses its currency for an empty bag', async () => {
    read.mockResolvedValue([product(1001, { currency: 'USD' })]);

    const result = await quotes.quoteBag({
      items: [],
      action: { type: 'add', productId: 'prd-1001', quantity: 2 },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      currency: 'USD',
      subtotal: 399.98,
      unitCount: 2,
      items: [{ productId: 'PRD-1001', quantity: 2, issue: null }],
    });
  });

  it.each([
    ['PRODUCT_UNAVAILABLE', []],
    ['INSUFFICIENT_STOCK', [product(1001, { stock: 0, inStock: false })]],
  ] as const)(
    'refuses an added line with %s after one read',
    async (code, rows) => {
      read.mockResolvedValue([...rows]);

      await expect(
        quotes.quoteBag({
          items: [],
          action: { type: 'add', productId: 'PRD-1001' },
        }),
      ).rejects.toMatchObject({
        code,
        response: { statusCode: 409, code, productId: 'PRD-1001' },
      });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it('reports currency mismatch before insufficient stock for an added line', async () => {
    read.mockResolvedValue([
      product(1001),
      product(1002, { currency: 'USD', stock: 0, inStock: false }),
    ]);

    await expect(
      quotes.quoteBag({
        items: [{ productId: 'PRD-1001', quantity: 1 }],
        action: { type: 'add', productId: 'PRD-1002' },
      }),
    ).rejects.toMatchObject({
      code: 'CURRENCY_MISMATCH',
      response: { statusCode: 409, productId: 'PRD-1002' },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses a raised line before checking the overall amount', async () => {
    read.mockResolvedValue([product(1001, { price: '9999999999.99' })]);

    await expect(
      quotes.quoteBag({
        items: [{ productId: 'PRD-1001', quantity: 2 }],
        action: { type: 'add', productId: 'PRD-1002' },
      }),
    ).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('still rejects a valid action whose new total exceeds the order limit', async () => {
    read.mockResolvedValue([product(1001, { price: '9999999999.99' })]);

    await expect(
      quotes.quoteBag({
        items: [{ productId: 'PRD-1001', quantity: 1 }],
        action: { type: 'increment', productId: 'PRD-1001' },
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_TOO_LARGE',
      response: { statusCode: 400 },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing unavailable line when adding a valid product', async () => {
    read.mockResolvedValue([product(1002)]);

    const result = await quotes.quoteBag({
      items: [{ productId: 'PRD-1001', quantity: 1 }],
      action: { type: 'add', productId: 'PRD-1002' },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      hasIssues: true,
      subtotal: 199.99,
      items: [
        {
          productId: 'PRD-1001',
          product: null,
          issue: 'PRODUCT_UNAVAILABLE',
        },
        { productId: 'PRD-1002', issue: null },
      ],
    });
  });

  it('allows reducing an insufficient-stock line while preserving its issue', async () => {
    read.mockResolvedValue([product(1001, { stock: 1 })]);

    const result = await quotes.quoteBag({
      items: [{ productId: 'PRD-1001', quantity: 3 }],
      action: { type: 'decrement', productId: 'PRD-1001' },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      subtotal: 399.98,
      hasIssues: true,
      items: [{ quantity: 2, issue: 'INSUFFICIENT_STOCK' }],
    });
  });

  it('rejects invalid merged quantities before loading products', async () => {
    const dto: BagQuoteDto = {
      items: [{ productId: 'PRD-1001', quantity: 1000 }],
      action: { type: 'increment', productId: 'PRD-1001' },
    };

    await expect(quotes.quoteBag(dto)).rejects.toMatchObject({
      code: 'INVALID_BAG',
      response: { statusCode: 400 },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not load products when removing the last line', async () => {
    const result = await quotes.quoteBag({
      items: [{ productId: 'PRD-1001', quantity: 1 }],
      action: { type: 'remove', productId: 'PRD-1001' },
    });

    expect(read).not.toHaveBeenCalled();
    expect(result).toEqual({
      currency: 'PKR',
      items: [],
      subtotal: 0,
      lineCount: 0,
      unitCount: 0,
      hasIssues: false,
    });
  });
});
