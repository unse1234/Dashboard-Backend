import { formatPublicId } from '../common/public-id';
import { SHOP_CURRENCY } from '../common/currency';
import {
  Prisma,
  type Currency,
  type PaymentMethod,
  type PaymentStatus,
} from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import { deductStock, type DeductedStock } from '../products/inventory';
import { toEventRows } from '../products/product-events';
import {
  commonCurrency,
  exceedsMaxOrderAmount,
  exceedsOrderValue,
  priceOrder,
  type PriceAdjustments,
} from './order-pricing';
import { orderDetailSelect, type OrderDetailRow } from './order.mapper';

/**
 * Why an order could not be placed. The core reports these as data; each caller
 * words them for its own audience (the dashboard may name a SKU and a count,
 * the storefront must not).
 */
export type PlacementFailure =
  /** Unknown, switched off, archived, or in another currency than required. */
  | { kind: 'PRODUCT_UNAVAILABLE'; productNumber: number | null }
  | {
      kind: 'INSUFFICIENT_STOCK';
      productNumber: number;
      sku: string;
      available: number;
    }
  | { kind: 'MIXED_CURRENCY' }
  | { kind: 'DISCOUNT_TOO_LARGE' }
  | { kind: 'TOO_LARGE' };

export class PlacementError extends Error {
  constructor(readonly failure: PlacementFailure) {
    super(failure.kind);
  }
}

/** The order as it was priced from the stock actually taken. */
export interface PricedOrder {
  currency: Currency;
  /** In the order the lines were given in. */
  lines: {
    number: number;
    quantity: number;
    unitPrice: Prisma.Decimal;
    currency: Currency;
  }[];
  subtotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

export interface PlaceOrderInput {
  /** The customer row the order belongs to, and what to snapshot on the order. */
  customer: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
  };
  /** One entry per product; the caller has refused repeats. */
  lines: { number: number; quantity: number }[];
  adjustments: PriceAdjustments;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  /** When set, a product in another currency is "not available". */
  requiredCurrency?: Currency;
  shippingAddress: Prisma.InputJsonObject;
  billingAddress: Prisma.InputJsonObject;
  /** Null when no signed-in person placed it (a guest). */
  actorId: string | null;
  /**
   * When set, the order waits for its buyer to confirm it from `email`'s inbox
   * by `expiresAt`, holding the stock it took until then. Left out, the order is
   * EXEMPT, as every staff order and every order before confirmation existed.
   */
  confirmation?: { email: string; expiresAt: Date };
  key: string;
  requestHash: string;
  /**
   * Looks at the order as priced from the stock actually taken, before anything
   * is written. Throwing rolls everything back; this is where a guest's quote is
   * held against what the order would really cost.
   */
  review?: (priced: PricedOrder) => void;
}

/**
 * Places an order inside the caller's transaction: takes the stock, prices the
 * lines from the products at that moment, snapshots the customer, addresses and
 * lines, and records the event. Either all of it is written or the caller's
 * transaction rolls back, so the caller must not swallow what this throws.
 *
 * The caller owns the idempotency lock and the replay check, and resolves the
 * customer; this owns everything that must be identical for every way an order
 * is placed.
 */
export async function placeOrder(
  tx: Db,
  input: PlaceOrderInput,
): Promise<OrderDetailRow> {
  const { lines, adjustments } = input;
  if (input.requiredCurrency && input.requiredCurrency !== SHOP_CURRENCY) {
    throw new PlacementError({
      kind: 'PRODUCT_UNAVAILABLE',
      productNumber: null,
    });
  }

  const products = await tx.product.findMany({
    where: { number: { in: lines.map((line) => line.number) } },
    select: {
      id: true,
      number: true,
      status: true,
      archivedAt: true,
      currency: true,
    },
  });
  const byNumber = new Map(products.map((p) => [p.number, p]));
  const requested = lines.map((line) => {
    const product = byNumber.get(line.number);
    if (
      !product ||
      product.status !== 'ACTIVE' ||
      product.archivedAt ||
      product.currency !== SHOP_CURRENCY ||
      (input.requiredCurrency && product.currency !== input.requiredCurrency)
    ) {
      throw new PlacementError({
        kind: 'PRODUCT_UNAVAILABLE',
        productNumber: line.number,
      });
    }
    return { ...line, productId: product.id, currency: product.currency };
  });
  // Refused before any stock is taken. The currency read together with each
  // deduction below is the one that counts.
  if (commonCurrency(requested.map((line) => line.currency)) === null) {
    throw new PlacementError({ kind: 'MIXED_CURRENCY' });
  }

  // Always in the same order (by id), so that two orders for overlapping
  // products wait for each other's rows in turn instead of deadlocking.
  const byProductId = [...requested].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
  const taken = new Map<string, DeductedStock>();
  for (const { productId, quantity } of byProductId) {
    const deducted = await deductStock(tx, productId, quantity);
    if (!deducted) throw await whyNoStock(tx, productId);
    taken.set(productId, deducted);
  }

  // Back in the order the lines were sent in, which is how they will list.
  const ordered = requested.map((line) => ({
    number: line.number,
    quantity: line.quantity,
    stock: taken.get(line.productId)!,
  }));
  const currency = commonCurrency(ordered.map(({ stock }) => stock.currency));
  const legacyLine = ordered.find(
    ({ stock }) => stock.currency !== SHOP_CURRENCY,
  );
  if (legacyLine) {
    throw new PlacementError({
      kind: 'PRODUCT_UNAVAILABLE',
      productNumber: legacyLine.number,
    });
  }
  if (currency === null) throw new PlacementError({ kind: 'MIXED_CURRENCY' });

  const price = priceOrder(
    ordered.map(({ quantity, stock }) => ({
      unitPrice: stock.price,
      quantity,
    })),
    adjustments,
  );
  if (exceedsOrderValue(price, adjustments)) {
    throw new PlacementError({ kind: 'DISCOUNT_TOO_LARGE' });
  }
  // Before the insert, so a big order is refused cleanly (and the stock it
  // took rolled back) instead of failing inside the database.
  if (
    exceedsMaxOrderAmount(price.subtotal) ||
    exceedsMaxOrderAmount(price.total)
  ) {
    throw new PlacementError({ kind: 'TOO_LARGE' });
  }

  input.review?.({
    currency,
    lines: ordered.map(({ number, quantity, stock }) => ({
      number,
      quantity,
      unitPrice: stock.price,
      currency: stock.currency,
    })),
    subtotal: price.subtotal,
    total: price.total,
  });

  const { customer } = input;
  const order = await tx.order.create({
    data: {
      customerId: customer.id,
      // Snapshots: the order keeps reading the same if these change.
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      status: 'PENDING',
      paymentStatus: input.paymentStatus,
      paymentMethod: input.paymentMethod,
      currency,
      subtotal: price.subtotal,
      shipping: adjustments.shipping,
      discount: adjustments.discount,
      tax: adjustments.tax,
      total: price.total,
      shippingAddress: input.shippingAddress,
      billingAddress: input.billingAddress,
      itemCount: ordered.reduce((sum, line) => sum + line.quantity, 0),
      idempotencyKey: input.key,
      requestHash: input.requestHash,
      ...(input.confirmation
        ? {
            confirmationStatus: 'AWAITING_CONFIRMATION' as const,
            confirmationEmail: input.confirmation.email,
            confirmationExpiresAt: input.confirmation.expiresAt,
          }
        : {}),
      items: {
        create: ordered.map(({ quantity, stock }, index) => ({
          productId: formatPublicId('PRD', stock.number),
          productName: stock.name,
          sku: stock.sku,
          quantity,
          unitPrice: stock.price,
          total: price.lineTotals[index],
          position: index,
          catalogProductId: stock.id,
        })),
      },
    },
    select: orderDetailSelect,
  });

  await tx.productEvent.createMany({
    data: [...taken.values()].flatMap((stock) =>
      toEventRows(stock.id, null, [
        {
          type: 'STOCK_CHANGED',
          data: {
            from: stock.stockBefore,
            to: stock.stockAfter,
            reason: 'ORDER_PLACED',
            orderNumber: order.number,
          },
        },
      ]),
    ),
  });
  await tx.orderEvent.create({
    data: {
      orderId: order.id,
      type: 'CREATED',
      toStatus: 'PENDING',
      toPaymentStatus: input.paymentStatus,
      actorId: input.actorId,
    },
  });

  return order;
}

/** Why nothing could be taken from a product: gone, switched off, or not enough. */
async function whyNoStock(db: Db, productId: string): Promise<PlacementError> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      number: true,
      sku: true,
      stock: true,
      status: true,
      archivedAt: true,
    },
  });
  if (!product || product.status !== 'ACTIVE' || product.archivedAt) {
    return new PlacementError({
      kind: 'PRODUCT_UNAVAILABLE',
      productNumber: product ? product.number : null,
    });
  }
  return new PlacementError({
    kind: 'INSUFFICIENT_STOCK',
    productNumber: product.number,
    sku: product.sku,
    available: product.stock,
  });
}
