import { formatPublicId } from '../common/public-id';
import { toAmount } from '../common/money';
import type { Prisma, ProductStatus } from '../generated/prisma/client';
import { describeEvent } from './product-events';

/** A product as the list, the details and the form show it. */
export interface ProductDto {
  /** Public id, "PRD-<number>". */
  id: string;
  name: string;
  sku: string;
  description: string | null;
  categoryId: string;
  /** The category's name. */
  category: string;
  brand: string | null;
  status: ProductStatus;
  /** Selling price in USD. */
  price: number;
  /** What the product costs the business in USD; null when unknown. */
  costPrice: number | null;
  stock: number;
  /**
   * Changes with every write. An edit must send the version it loaded, and is
   * refused when the product has changed since.
   */
  version: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

export interface ProductHistoryEntryDto {
  id: string;
  /** What happened, already phrased for display. */
  change: string;
  /** ISO 8601. */
  occurredAt: string;
  /** The person responsible; null for automatic changes. */
  actor: string | null;
}

// Each mapper lists its fields explicitly, so internal columns such as the uuid
// never reach a response.
export const productSelect = {
  id: true,
  number: true,
  name: true,
  sku: true,
  description: true,
  brand: true,
  categoryId: true,
  category: { select: { name: true } },
  status: true,
  price: true,
  costPrice: true,
  stock: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

export type ProductRow = Prisma.ProductGetPayload<{
  select: typeof productSelect;
}>;

export function toProductDto(row: ProductRow): ProductDto {
  return {
    id: formatPublicId('PRD', row.number),
    name: row.name,
    sku: row.sku,
    description: row.description,
    categoryId: row.categoryId,
    category: row.category.name,
    brand: row.brand,
    status: row.status,
    price: toAmount(row.price),
    costPrice: row.costPrice === null ? null : toAmount(row.costPrice),
    stock: row.stock,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const productEventSelect = {
  id: true,
  type: true,
  data: true,
  createdAt: true,
  actor: { select: { name: true } },
} satisfies Prisma.ProductEventSelect;

export function toHistoryEntry(
  event: Prisma.ProductEventGetPayload<{ select: typeof productEventSelect }>,
): ProductHistoryEntryDto {
  return {
    id: event.id,
    change: describeEvent(event.type, event.data),
    occurredAt: event.createdAt.toISOString(),
    actor: event.actor?.name ?? null,
  };
}
