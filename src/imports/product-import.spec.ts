import type { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import type { ParsedProductCsv } from './csv.parser';
import type { ProductImportColumn } from './import.constants';
import { analyzeProductRows } from './product-import';

const CATEGORY_ID = '7a1d0b52-44b1-4c04-9d38-5d7a2f3c9b11';

type Cells = Partial<Record<ProductImportColumn, string>>;

function parsed(...rows: Cells[]): ParsedProductCsv {
  return {
    mapping: {},
    rows: rows.map((cells, index) => ({ rowNumber: index + 2, cells })),
  };
}

const valid = (overrides: Cells = {}): Cells => ({
  name: 'Blue Mug',
  sku: 'MUG-1',
  category: 'Home',
  price: '12.50',
  ...overrides,
});

/**
 * A stand-in for the database: categories, plus the two raw queries the
 * validator runs (lower-casing the incoming SKUs, then looking for existing ones).
 */
function fakeDb(existingSkus: string[] = []): Db {
  const existing = new Set(existingSkus.map((sku) => sku.toLowerCase()));
  const queryRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const values0 = (values[0] as Prisma.Sql).values as string[];
    if (strings.join('?').includes('unnest')) {
      return Promise.resolve(
        values0.map((sku) => ({ sku, key: sku.toLowerCase() })),
      );
    }
    return Promise.resolve(
      values0.filter((key) => existing.has(key)).map((key) => ({ key })),
    );
  };
  return {
    category: {
      findMany: () => Promise.resolve([{ id: CATEGORY_ID, name: 'Home' }]),
    },
    $queryRaw: queryRaw,
  } as unknown as Db;
}

const codes = (result: Awaited<ReturnType<typeof analyzeProductRows>>) =>
  result.issues.map(({ rowNumber, field, code }) => [rowNumber, field, code]);

describe('analyzeProductRows', () => {
  describe('valid rows', () => {
    it('normalizes values and applies the product defaults', async () => {
      const result = await analyzeProductRows(
        parsed(valid({ name: '  Blue Mug ', sku: ' MUG-1 ' })),
        fakeDb(),
      );

      expect(result.issues).toEqual([]);
      expect(result.validRows).toEqual([
        {
          rowNumber: 2,
          dto: {
            name: 'Blue Mug',
            sku: 'MUG-1',
            categoryId: CATEGORY_ID,
            price: 12.5,
            costPrice: null,
            stock: 0,
            status: 'ACTIVE',
            brand: null,
            description: null,
          },
        },
      ]);
      expect(result.payload.rows[0]).toMatchObject({
        rowNumber: 2,
        categoryId: CATEGORY_ID,
        issues: [],
      });
    });

    it('reads optional columns and normalizes the status case', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({
            costPrice: '4',
            stock: '25',
            status: 'inactive',
            brand: 'Acme',
            description: 'Line one\nLine two',
          }),
        ),
        fakeDb(),
      );

      expect(result.validRows[0].dto).toMatchObject({
        costPrice: 4,
        stock: 25,
        status: 'INACTIVE',
        brand: 'Acme',
        description: 'Line one\nLine two',
      });
    });

    it.each(['0', '0.5', '12.5', '12.50', '1000000'])(
      'accepts the amount %s',
      async (price) => {
        const result = await analyzeProductRows(
          parsed(valid({ price })),
          fakeDb(),
        );

        expect(result.issues).toEqual([]);
      },
    );

    it.each(['0', '1000000'])('accepts the stock %s', async (stock) => {
      const result = await analyzeProductRows(
        parsed(valid({ stock })),
        fakeDb(),
      );

      expect(result.issues).toEqual([]);
    });

    it('keeps formula-looking text as literal text', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ name: '=SUM(A1:A9)', brand: '+cmd|calc', sku: '@SKU-1' }),
        ),
        fakeDb(),
      );

      expect(result.issues).toEqual([]);
      expect(result.validRows[0].dto).toMatchObject({
        name: '=SUM(A1:A9)',
        brand: '+cmd|calc',
      });
    });

    it('does not treat the literal text null as an empty value', async () => {
      const result = await analyzeProductRows(
        parsed(valid({ brand: 'null' })),
        fakeDb(),
      );

      expect(result.validRows[0].dto.brand).toBe('null');
    });
  });

  describe('row errors', () => {
    it('requires name, sku, category and price', async () => {
      const result = await analyzeProductRows(
        parsed({ name: '', sku: ' ', category: '', price: '' }),
        fakeDb(),
      );

      expect(codes(result)).toEqual([
        [2, 'name', 'REQUIRED'],
        [2, 'sku', 'REQUIRED'],
        [2, 'category', 'REQUIRED'],
        [2, 'price', 'REQUIRED'],
      ]);
      expect(result.validRows).toEqual([]);
    });

    it.each([
      '1e3',
      '-1',
      '$5',
      '1,000',
      '1.234',
      'NaN',
      'Infinity',
      '.5',
      '5.',
      '1000000.01',
    ])('rejects the amount %j', async (price) => {
      const result = await analyzeProductRows(
        parsed(valid({ price })),
        fakeDb(),
      );

      expect(codes(result)).toEqual([[2, 'price', 'INVALID_MONEY']]);
    });

    it('rejects an invalid cost price, and the text null', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ costPrice: 'null' }),
          valid({ sku: 'B', costPrice: '1.999' }),
        ),
        fakeDb(),
      );

      expect(codes(result)).toEqual([
        [2, 'costPrice', 'INVALID_MONEY'],
        [3, 'costPrice', 'INVALID_MONEY'],
      ]);
    });

    it.each(['1.5', '-1', '1e3', '1000001', 'ten'])(
      'rejects the stock %j',
      async (stock) => {
        const result = await analyzeProductRows(
          parsed(valid({ stock })),
          fakeDb(),
        );

        expect(codes(result)).toEqual([[2, 'stock', 'INVALID_STOCK']]);
      },
    );

    it('rejects a status other than ACTIVE or INACTIVE', async () => {
      const result = await analyzeProductRows(
        parsed(valid({ status: 'ARCHIVED' })),
        fakeDb(),
      );

      expect(codes(result)).toEqual([[2, 'status', 'UNSUPPORTED_STATUS']]);
    });

    it('enforces the product field lengths and the SKU format', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ name: 'A', sku: 'L-1' }),
          valid({ sku: 'has space' }),
          valid({ sku: 'S'.repeat(65) }),
          valid({ brand: 'B'.repeat(81), sku: 'L-4' }),
          valid({ description: 'D'.repeat(2001), sku: 'L-5' }),
        ),
        fakeDb(),
      );

      expect(codes(result)).toEqual([
        [2, 'name', 'INVALID_NAME'],
        [3, 'sku', 'INVALID_SKU'],
        [4, 'sku', 'INVALID_SKU'],
        [5, 'brand', 'TOO_LONG'],
        [6, 'description', 'TOO_LONG'],
      ]);
    });

    it('matches category names exactly, with no case folding or creation', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ category: 'home' }),
          valid({ sku: 'B', category: 'Garden' }),
        ),
        fakeDb(),
      );

      expect(codes(result)).toEqual([
        [2, 'category', 'UNKNOWN_CATEGORY'],
        [3, 'category', 'UNKNOWN_CATEGORY'],
      ]);
    });

    it('never echoes the submitted value in a message', async () => {
      const result = await analyzeProductRows(
        parsed(valid({ price: 'SECRET-PRICE', category: 'SECRET-CATEGORY' })),
        fakeDb(),
      );

      expect(JSON.stringify(result.issues)).not.toContain('SECRET');
    });
  });

  describe('SKU uniqueness', () => {
    it('flags every occurrence of a SKU repeated in the file, ignoring case', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ sku: 'Dup-1' }),
          valid({ sku: 'OK-1' }),
          valid({ sku: 'dup-1' }),
          valid({ sku: 'DUP-1' }),
        ),
        fakeDb(),
      );

      expect(codes(result)).toEqual([
        [2, 'sku', 'DUPLICATE_SKU_FILE'],
        [4, 'sku', 'DUPLICATE_SKU_FILE'],
        [5, 'sku', 'DUPLICATE_SKU_FILE'],
      ]);
      expect(result.validRows.map((row) => row.dto.sku)).toEqual(['OK-1']);
    });

    it('flags a SKU that already exists, whatever its case', async () => {
      const result = await analyzeProductRows(
        parsed(valid({ sku: 'taken' }), valid({ sku: 'free' })),
        fakeDb(['TAKEN']),
      );

      expect(codes(result)).toEqual([[2, 'sku', 'SKU_EXISTS']]);
      expect(result.validRows.map((row) => row.dto.sku)).toEqual(['free']);
    });

    it('reports both conflicts and lists issues in file order', async () => {
      const result = await analyzeProductRows(
        parsed(
          valid({ sku: 'DUP', price: 'x' }),
          valid({ sku: 'TAKEN' }),
          valid({ sku: 'DUP' }),
        ),
        fakeDb(['taken']),
      );

      expect(codes(result)).toEqual([
        [2, 'price', 'INVALID_MONEY'],
        [2, 'sku', 'DUPLICATE_SKU_FILE'],
        [3, 'sku', 'SKU_EXISTS'],
        [4, 'sku', 'DUPLICATE_SKU_FILE'],
      ]);
    });
  });

  it('keeps invalid rows in the payload so every row can be reviewed', async () => {
    const result = await analyzeProductRows(
      parsed(valid(), valid({ sku: 'B', price: 'bad' })),
      fakeDb(),
    );

    expect(result.payload.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(result.payload.rows[1].issues).toHaveLength(1);
    expect(result.validRows).toHaveLength(1);
  });
});
