import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma, type ProductStatus } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import { CreateProductDto } from '../products/dto/create-product.dto';
import {
  BRAND_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PRICE_MAX,
  SKU_MAX_LENGTH,
  STOCK_MAX,
} from '../products/dto/product-fields';
import type { ParsedProductCsv } from './csv.parser';
import type {
  ImportPreviewPayload,
  ProductImportRow,
  ProductImportValues,
  RowIssue,
  ValidProductRow,
} from './import.types';

const amountPattern = /^\d+(?:\.\d{1,2})?$/;
const integerPattern = /^\d+$/;
const MONEY_MESSAGE = `Use an amount from 0 to ${PRICE_MAX} with at most two decimals.`;

function valueOrEmpty(value: string | undefined): string {
  return (value ?? '').trim();
}

function normalizeValues(
  cells: ParsedProductCsv['rows'][number]['cells'],
): ProductImportValues {
  return {
    name: valueOrEmpty(cells.name),
    sku: valueOrEmpty(cells.sku),
    category: valueOrEmpty(cells.category),
    price: valueOrEmpty(cells.price),
    costPrice: valueOrEmpty(cells.costPrice),
    stock: valueOrEmpty(cells.stock),
    status: valueOrEmpty(cells.status),
    brand: valueOrEmpty(cells.brand),
    description: valueOrEmpty(cells.description),
  };
}

function issue(
  rowNumber: number,
  field: RowIssue['field'],
  code: string,
  message: string,
): RowIssue {
  return { rowNumber, field, code, message };
}

/** Uses Postgres lower(), exactly like the database's unique SKU index. */
async function skuKeys(db: Db, skus: string[]): Promise<Map<string, string>> {
  if (skus.length === 0) return new Map();
  const result = await db.$queryRaw<{ sku: string; key: string }[]>`
    SELECT input.sku, lower(input.sku) AS key
    FROM unnest(ARRAY[${Prisma.join(skus)}]::text[]) AS input(sku)`;
  return new Map(result.map((row) => [row.sku, row.key]));
}

export async function analyzeProductRows(
  parsed: ParsedProductCsv,
  db: Db,
): Promise<{
  payload: ImportPreviewPayload;
  issues: RowIssue[];
  validRows: ValidProductRow[];
}> {
  const categories = await db.category.findMany({
    select: { id: true, name: true },
  });
  const byCategory = new Map(
    categories.map((category) => [category.name, category.id]),
  );
  const rows: ProductImportRow[] = [];
  const allIssues: RowIssue[] = [];

  for (const { rowNumber, cells } of parsed.rows) {
    const values = normalizeValues(cells);
    const issues: RowIssue[] = [];
    for (const field of ['name', 'sku', 'category', 'price'] as const) {
      if (!values[field])
        issues.push(
          issue(rowNumber, field, 'REQUIRED', `${field} is required.`),
        );
    }
    if (
      values.name &&
      (values.name.length < NAME_MIN_LENGTH ||
        values.name.length > NAME_MAX_LENGTH)
    ) {
      issues.push(
        issue(
          rowNumber,
          'name',
          'INVALID_NAME',
          `Use ${NAME_MIN_LENGTH} to ${NAME_MAX_LENGTH} characters.`,
        ),
      );
    }
    if (
      values.sku &&
      (values.sku.length > SKU_MAX_LENGTH || /\s/.test(values.sku))
    ) {
      issues.push(
        issue(
          rowNumber,
          'sku',
          'INVALID_SKU',
          `Use at most ${SKU_MAX_LENGTH} characters without spaces.`,
        ),
      );
    }
    if (values.category && !byCategory.has(values.category)) {
      issues.push(
        issue(
          rowNumber,
          'category',
          'UNKNOWN_CATEGORY',
          'Use an existing category name.',
        ),
      );
    }
    if (
      values.price &&
      (!amountPattern.test(values.price) || Number(values.price) > PRICE_MAX)
    ) {
      issues.push(issue(rowNumber, 'price', 'INVALID_MONEY', MONEY_MESSAGE));
    }
    if (
      values.costPrice &&
      (!amountPattern.test(values.costPrice) ||
        Number(values.costPrice) > PRICE_MAX)
    ) {
      issues.push(
        issue(rowNumber, 'costPrice', 'INVALID_MONEY', MONEY_MESSAGE),
      );
    }
    if (
      values.stock &&
      (!integerPattern.test(values.stock) || Number(values.stock) > STOCK_MAX)
    ) {
      issues.push(
        issue(
          rowNumber,
          'stock',
          'INVALID_STOCK',
          `Use a whole number from 0 to ${STOCK_MAX}.`,
        ),
      );
    }
    if (
      values.status &&
      !['ACTIVE', 'INACTIVE'].includes(values.status.toUpperCase())
    ) {
      issues.push(
        issue(
          rowNumber,
          'status',
          'UNSUPPORTED_STATUS',
          'Use ACTIVE or INACTIVE.',
        ),
      );
    }
    if (values.brand.length > BRAND_MAX_LENGTH)
      issues.push(
        issue(
          rowNumber,
          'brand',
          'TOO_LONG',
          `Use at most ${BRAND_MAX_LENGTH} characters.`,
        ),
      );
    if (values.description.length > DESCRIPTION_MAX_LENGTH)
      issues.push(
        issue(
          rowNumber,
          'description',
          'TOO_LONG',
          `Use at most ${DESCRIPTION_MAX_LENGTH} characters.`,
        ),
      );

    const categoryId = byCategory.get(values.category) ?? null;
    if (issues.length === 0 && categoryId) {
      const dto = plainToInstance(CreateProductDto, {
        name: values.name,
        sku: values.sku,
        categoryId,
        price: Number(values.price),
        costPrice: values.costPrice ? Number(values.costPrice) : null,
        stock: values.stock ? Number(values.stock) : 0,
        status: (values.status
          ? values.status.toUpperCase()
          : 'ACTIVE') as ProductStatus,
        brand: values.brand || null,
        description: values.description || null,
      });
      for (const failure of validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      })) {
        const field = failure.property as RowIssue['field'];
        issues.push(
          issue(
            rowNumber,
            field,
            'INVALID_VALUE',
            `${field} has an invalid value.`,
          ),
        );
      }
    }
    rows.push({ rowNumber, values, categoryId, issues });
    allIssues.push(...issues);
  }

  const keys = await skuKeys(db, [
    ...new Set(rows.map((row) => row.values.sku).filter(Boolean)),
  ]);
  const occurrences = new Map<string, ProductImportRow[]>();
  for (const row of rows) {
    const key = keys.get(row.values.sku);
    if (!key) continue;
    const group = occurrences.get(key) ?? [];
    group.push(row);
    occurrences.set(key, group);
  }
  const uniqueKeys = [...occurrences.keys()];
  const existing = uniqueKeys.length
    ? await db.$queryRaw<{ key: string }[]>`
      SELECT lower("sku") AS key FROM "Product"
      WHERE lower("sku") IN (${Prisma.join(uniqueKeys)})`
    : [];
  const existingKeys = new Set(existing.map((row) => row.key));
  for (const [key, group] of occurrences) {
    for (const row of group) {
      if (group.length > 1) {
        const next = issue(
          row.rowNumber,
          'sku',
          'DUPLICATE_SKU_FILE',
          'This SKU appears more than once in the CSV.',
        );
        row.issues.push(next);
        allIssues.push(next);
      }
      if (existingKeys.has(key)) {
        const next = issue(
          row.rowNumber,
          'sku',
          'SKU_EXISTS',
          'A product with this SKU already exists.',
        );
        row.issues.push(next);
        allIssues.push(next);
      }
    }
  }

  // Duplicate-SKU checks run after the per-row ones; report in file order.
  allIssues.sort((a, b) => a.rowNumber - b.rowNumber);

  const validRows: ValidProductRow[] = rows
    .filter((row) => row.issues.length === 0)
    .map((row) => ({
      rowNumber: row.rowNumber,
      dto: {
        name: row.values.name,
        sku: row.values.sku,
        categoryId: row.categoryId!,
        price: Number(row.values.price),
        costPrice: row.values.costPrice ? Number(row.values.costPrice) : null,
        stock: row.values.stock ? Number(row.values.stock) : 0,
        status: (row.values.status
          ? row.values.status.toUpperCase()
          : 'ACTIVE') as ProductStatus,
        brand: row.values.brand || null,
        description: row.values.description || null,
      },
    }));
  return {
    payload: { mapping: parsed.mapping, rows },
    issues: allIssues,
    validRows,
  };
}
