import { Prisma, type Currency } from '../../generated/prisma/client';

/**
 * The currency of an empty bag, which has no product to take one from. A
 * product's price is never relabelled or converted: it is shown, quoted and
 * charged in the currency it is stored in.
 */
export const DEFAULT_BAG_CURRENCY: Currency = 'PKR';

/**
 * Which products the public catalogue shows (the query aliases `Product` as
 * `p`): on sale, not archived, and with a real price, in whichever currency it
 * is priced. Sold-out products are included; they are listed as not in stock.
 *
 * Everything public reads through this one condition, so the list, the details
 * and the readiness report can never disagree about what is visible.
 */
export const eligibleProduct = Prisma.sql`(
  p."archivedAt" IS NULL
  AND p."status" = 'ACTIVE'
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
