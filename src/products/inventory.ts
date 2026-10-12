import { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';

/** A product that stock was just taken from, as it was priced at that moment. */
export interface DeductedStock {
  id: string;
  number: number;
  name: string;
  sku: string;
  /** The selling price at the moment the stock was taken. */
  price: Prisma.Decimal;
  stockBefore: number;
  stockAfter: number;
}

export interface RestoredStock {
  id: string;
  stockBefore: number;
  stockAfter: number;
}

interface StockRow {
  id: string;
  number: number;
  name: string;
  sku: string;
  price: string;
  stock: number;
}

/**
 * Takes `quantity` units from an active product's stock and reads its name,
 * SKU and price in the same statement, so an order snapshots exactly what it
 * took.
 *
 * Checking and changing are one UPDATE, not a read followed by a write. Under
 * READ COMMITTED a second UPDATE of the same row waits for the first to commit
 * and then re-checks `stock >= quantity` against the new value, so two orders
 * for the last unit can never both succeed. (The CHECK on the column is the
 * backstop; this is what makes the loser a clean "not enough stock" instead.)
 *
 * Returns null when nothing was taken: the product is missing, inactive or
 * archived, or has less than `quantity` in stock.
 */
export async function deductStock(
  db: Db,
  productId: string,
  quantity: number,
): Promise<DeductedStock | null> {
  const rows = await db.$queryRaw<StockRow[]>`
    UPDATE "Product"
    SET "stock" = "stock" - ${quantity},
        "version" = "version" + 1,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "id" = ${productId}
      AND "status" = 'ACTIVE'
      AND "archivedAt" IS NULL
      AND "stock" >= ${quantity}
    RETURNING "id", "number", "name", "sku", "price"::text AS "price", "stock"`;

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    sku: row.sku,
    price: new Prisma.Decimal(row.price),
    stockBefore: row.stock + quantity,
    stockAfter: row.stock,
  };
}

/**
 * Puts units back, whatever the product's status: they are physically back on
 * the shelf, so an archived or inactive product gets them too. Locks the rows
 * in a fixed order (by id), like every other multi-product write, so two
 * operations over the same products cannot deadlock.
 *
 * It is not idempotent by itself. A caller makes it so by calling it only for
 * the request whose conditional status update actually changed the order.
 */
export async function restoreStock(
  db: Db,
  lines: { productId: string; quantity: number }[],
): Promise<RestoredStock[]> {
  const restored: RestoredStock[] = [];
  const ordered = [...lines].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );

  for (const { productId, quantity } of ordered) {
    const rows = await db.$queryRaw<{ id: string; stock: number }[]>`
      UPDATE "Product"
      SET "stock" = "stock" + ${quantity},
          "version" = "version" + 1,
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${productId}
      RETURNING "id", "stock"`;
    const row = rows[0];
    if (row) {
      restored.push({
        id: row.id,
        stockBefore: row.stock - quantity,
        stockAfter: row.stock,
      });
    }
  }
  return restored;
}
