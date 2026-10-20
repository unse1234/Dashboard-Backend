import { toAmount } from '../common/money';
import { formatPublicId } from '../common/public-id';
import type {
  Currency,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client';
import { toAddress, type OrderAddressDto } from '../orders/order.mapper';
import type { StorefrontReceiptItem } from '../orders/storefront/storefront-order.mapper';

/**
 * One order in a shopper's history. Every field is picked by name, from the
 * order's own snapshots: no customer record, internal id, idempotency data,
 * event history, actor or confirmation address is ever part of it.
 */
export interface StorefrontAccountOrderSummary {
  /** The order reference, "ORD-<number>". */
  id: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601: when the shopper confirmed it by email. */
  confirmedAt: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  currency: Currency;
  /** Units across all lines. */
  itemCount: number;
  total: number;
}

/** One order in full, as its buyer placed it. */
export interface StorefrontAccountOrder extends StorefrontAccountOrderSummary {
  items: StorefrontReceiptItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  /** What the shopper typed at checkout, as it was recorded then. */
  delivery: {
    contactName: string;
    phone: string | null;
    address: OrderAddressDto;
  };
}

export interface StorefrontAccountOrderPage {
  data: StorefrontAccountOrderSummary[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

// Only stored columns: the list reads no order lines (itemCount is a column).
export const accountOrderSummarySelect = {
  number: true,
  createdAt: true,
  confirmedAt: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  currency: true,
  itemCount: true,
  total: true,
} satisfies Prisma.OrderSelect;

export const accountOrderSelect = {
  ...accountOrderSummarySelect,
  subtotal: true,
  shipping: true,
  tax: true,
  discount: true,
  customerName: true,
  customerPhone: true,
  shippingAddress: true,
  items: {
    select: {
      productId: true,
      productName: true,
      quantity: true,
      unitPrice: true,
      total: true,
    },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.OrderSelect;

type SummaryRow = Prisma.OrderGetPayload<{
  select: typeof accountOrderSummarySelect;
}>;
type DetailRow = Prisma.OrderGetPayload<{ select: typeof accountOrderSelect }>;

export function toAccountOrderSummary(
  row: SummaryRow,
): StorefrontAccountOrderSummary {
  if (!row.confirmedAt) {
    // Owned orders are confirmed ones (a CHECK); this is only a type guard.
    throw new Error('An owned order without confirmedAt');
  }
  return {
    id: formatPublicId('ORD', row.number),
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt.toISOString(),
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    currency: row.currency,
    itemCount: row.itemCount,
    total: toAmount(row.total),
  };
}

export function toAccountOrder(row: DetailRow): StorefrontAccountOrder {
  return {
    ...toAccountOrderSummary(row),
    items: row.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: toAmount(item.unitPrice),
      total: toAmount(item.total),
    })),
    subtotal: toAmount(row.subtotal),
    shipping: toAmount(row.shipping),
    tax: toAmount(row.tax),
    discount: toAmount(row.discount),
    delivery: {
      contactName: row.customerName,
      phone: row.customerPhone,
      address: toAddress(row.shippingAddress),
    },
  };
}
