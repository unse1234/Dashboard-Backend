import type { Db } from '../prisma/prisma.service';
import { restoreStock } from '../products/inventory';
import { toEventRows } from '../products/product-events';

/**
 * Puts back what an order took, and records it on each product's history.
 * Shared by every way an order ends without being fulfilled (staff cancelling
 * it, or it expiring unconfirmed), so the stock comes back the same way.
 *
 * Not idempotent by itself: call it only from the request whose conditional
 * update actually moved the order to CANCELLED, in the same transaction.
 */
export async function returnOrderStock(
  db: Db,
  orderId: string,
  orderNumber: number,
): Promise<void> {
  const lines = await db.orderItem.findMany({
    where: { orderId, catalogProductId: { not: null } },
    select: { catalogProductId: true, quantity: true },
  });

  const quantities = new Map<string, number>();
  for (const { catalogProductId, quantity } of lines) {
    if (catalogProductId === null) continue;
    quantities.set(
      catalogProductId,
      (quantities.get(catalogProductId) ?? 0) + quantity,
    );
  }

  const restored = await restoreStock(
    db,
    [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
  );
  if (restored.length === 0) return;
  await db.productEvent.createMany({
    data: restored.flatMap((stock) =>
      toEventRows(stock.id, null, [
        {
          type: 'STOCK_CHANGED',
          data: {
            from: stock.stockBefore,
            to: stock.stockAfter,
            reason: 'ORDER_CANCELLED',
            orderNumber,
          },
        },
      ]),
    ),
  });
}
