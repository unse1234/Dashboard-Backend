import { formatPublicId } from '../common/public-id';
import { toAmount } from '../common/money';
import type {
  Currency,
  Prisma,
  ProductStatus,
} from '../generated/prisma/client';
import { describeEvent } from './product-events';

/** A product as the list, the details and the form show it. */
export interface ProductDto {
  /** Public id, "PRD-<number>". */
  id: string;
  name: string;
  sku: string;
  subtitle: string | null;
  description: string | null;
  categoryId: string;
  /** The category's name. */
  category: string;
  brand: string | null;
  /** The primary image: an http(s) URL or a path on the storefront. */
  imageUrl: string | null;
  /** Further images, in display order. */
  galleryUrls: string[];
  status: ProductStatus;
  /** Selling price, in `currency`. */
  price: number;
  /** What `price` and `costPrice` are denominated in. */
  currency: Currency;
  /** What the product costs the business, in `currency`; null when unknown. */
  costPrice: number | null;
  /**
   * Profit as a share of the selling price, to four decimals (0.255 is 25.5%):
   * negative when it sells below cost. Null without a cost price, or at a price
   * of zero. Worked out here, in exact decimals, not by each screen.
   */
  margin: number | null;
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
  subtitle: true,
  description: true,
  brand: true,
  imageUrl: true,
  galleryUrls: true,
  categoryId: true,
  category: { select: { name: true } },
  status: true,
  price: true,
  currency: true,
  costPrice: true,
  stock: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

export type ProductRow = Prisma.ProductGetPayload<{
  select: typeof productSelect;
}>;

/** (price - cost) / price in exact decimals, rounded to four places. */
export function marginOf(
  price: Prisma.Decimal,
  costPrice: Prisma.Decimal | null,
): number | null {
  if (costPrice === null || price.isZero()) return null;
  return price.minus(costPrice).div(price).toDecimalPlaces(4).toNumber();
}

export function toProductDto(row: ProductRow): ProductDto {
  return {
    id: formatPublicId('PRD', row.number),
    name: row.name,
    sku: row.sku,
    subtitle: row.subtitle,
    description: row.description,
    categoryId: row.categoryId,
    category: row.category.name,
    brand: row.brand,
    imageUrl: row.imageUrl,
    galleryUrls: row.galleryUrls,
    status: row.status,
    price: toAmount(row.price),
    currency: row.currency,
    costPrice: row.costPrice === null ? null : toAmount(row.costPrice),
    margin: marginOf(row.price, row.costPrice),
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
