import { Prisma, type Currency } from '../../generated/prisma/client';

/**
 * The one currency the storefront sells in. A product priced in anything else
 * is not shown: its number is never relabelled or converted.
 */
export const STOREFRONT_CURRENCY: Currency = 'PKR';

/**
 * Which products the public catalogue shows (the query aliases `Product` as
 * `p`): on sale, not archived, and priced in the storefront's currency with a
 * real price. Sold-out products are included; they are listed as not in stock.
 *
 * Everything public reads through this one condition, so the list, the details
 * and the readiness report can never disagree about what is visible.
 */
export const eligibleProduct = Prisma.sql`(
  p."archivedAt" IS NULL
  AND p."status" = 'ACTIVE'
  AND p."currency" = ${STOREFRONT_CURRENCY}::"Currency"
  AND p."price" > 0
)`;

/** The columns of a product row the public projection is built from. */
export interface StorefrontProductRow {
  number: number;
  name: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  imageUrl: string | null;
  galleryUrls: string[];
  price: string;
  currency: Currency;
  inStock: boolean;
  categoryId: string;
  categoryName: string;
}

/**
 * Only what a visitor may see: no internal id, SKU, cost price, version,
 * exact stock count or history. Availability is a yes/no computed in the query,
 * so the count itself never leaves the database.
 */
export const storefrontProductColumns = Prisma.sql`
  p."number", p."name", p."subtitle", p."description", p."brand",
  p."imageUrl", p."galleryUrls",
  p."price"::text AS "price", p."currency"::text AS "currency",
  (p."stock" > 0) AS "inStock",
  c."id" AS "categoryId", c."name" AS "categoryName"`;

/** A product row that also carries its stock, for checking a quantity against it. */
export interface StorefrontStockedProductRow extends StorefrontProductRow {
  stock: number;
}

/**
 * The public columns plus the stock count. For server-side availability checks
 * only: the count is compared with a quantity and never mapped into a response.
 */
export const storefrontStockedProductColumns = Prisma.sql`
  ${storefrontProductColumns},
  p."stock" AS "stock"`;
