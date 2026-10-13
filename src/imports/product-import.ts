import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Prisma, type ProductStatus } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import { CreateProductDto } from '../products/dto/create-product.dto';
import {
  BRAND_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
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
/**
 * Stands in for the id of a category the import is about to create, so the row
 * still passes the product DTO's `@IsUUID()` check. It is never stored.
 */
const NEW_CATEGORY_PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

interface CategoryRef {
  id: string;
  name: string;
}

/**
 * An exact name wins; otherwise a case-insensitive match is used, so
 * "electronics" lands in "Electronics" instead of creating a near-duplicate.
 */
function categoryLookup(categories: CategoryRef[]) {
  const exact = new Map(
    categories.map((category) => [category.name, category]),
  );
  const folded = new Map<string, CategoryRef>();
  for (const category of [...categories].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const key = category.name.toLowerCase();
    if (!folded.has(key)) folded.set(key, category);
  }
  return (name: string): CategoryRef | undefined =>
    exact.get(name) ?? folded.get(name.toLowerCase());
}

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

/**
 * Creates the categories the file introduced and returns the rows ready for
 * `createProductsInTransaction`. Run it inside the import's transaction, so a
 * failed import leaves no category behind.
 */
export async function withCategoryIds(
  db: Db,
  rows: ValidProductRow[],
): Promise<
  (Omit<ValidProductRow['dto'], 'categoryId'> & { categoryId: string })[]
> {
  const missing = [
    ...new Set(
      rows
        .filter((row) => row.dto.categoryId === null)
        .map((row) => row.categoryName),
    ),
  ];
  const created = new Map<string, string>();
  if (missing.length > 0) {
    await db.category.createMany({
      data: missing.map((name) => ({ name })),
      skipDuplicates: true,
    });
    const found = await db.category.findMany({
      where: { name: { in: missing } },
      select: { id: true, name: true },
    });
    for (const category of found) created.set(category.name, category.id);
  }
  return rows.map(({ dto, categoryName }) => {
    const categoryId = dto.categoryId ?? created.get(categoryName);
    if (!categoryId) throw new Error('A category could not be resolved.');
    return { ...dto, categoryId };
  });
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
  const findCategory = categoryLookup(categories);
  // Lower-cased name -> the spelling the file used first, for categories that
  // do not exist yet. "Toys" and "toys" in one file become one new category.
  const newCategoryNames = new Map<string, string>();
  const categoryNameByRow = new Map<number, string>();
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
    // A name no category has yet is created when the import is confirmed.
    const existingCategory = values.category
      ? findCategory(values.category)
      : undefined;
    let categoryName = existingCategory?.name ?? values.category;
    if (values.category && !existingCategory) {
      if (values.category.length > CATEGORY_NAME_MAX_LENGTH) {
        issues.push(
          issue(
            rowNumber,
            'category',
            'TOO_LONG',
            `Use at most ${CATEGORY_NAME_MAX_LENGTH} characters.`,
          ),
        );
      } else {
        const key = values.category.toLowerCase();
        categoryName = newCategoryNames.get(key) ?? values.category;
        newCategoryNames.set(key, categoryName);
      }
    }
    categoryNameByRow.set(rowNumber, categoryName);
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

    const categoryId = existingCategory?.id ?? null;
    if (issues.length === 0) {
      const dto = plainToInstance(CreateProductDto, {
        name: values.name,
        sku: values.sku,
        categoryId: categoryId ?? NEW_CATEGORY_PLACEHOLDER_ID,
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
      categoryName: categoryNameByRow.get(row.rowNumber)!,
      dto: {
        name: row.values.name,
        sku: row.values.sku,
        categoryId: row.categoryId,
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
