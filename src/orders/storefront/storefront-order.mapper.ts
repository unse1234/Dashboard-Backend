import { toAmount } from '../../common/money';
import type {
  Currency,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../generated/prisma/client';
import { formatPublicId } from '../../common/public-id';
import type { OrderDetailRow } from '../order.mapper';

export interface StorefrontReceiptItem {
  /** The product's public id, "PRD-<number>". */
  productId: string;
  productName: string;
  quantity: number;
  /** In `currency`. */
  unitPrice: number;
  /** quantity x unitPrice, in `currency`. */
  total: number;
}

/**
 * What a guest is told about the order they placed. It is a reference for
 * display, not a credential: nothing about the customer, no internal id, no
 * idempotency key or request hash, no actor and no history.
 */
export interface StorefrontReceipt {
  /** The order reference, "ORD-<number>". */
  id: string;
  /** ISO 8601. */
  createdAt: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  currency: Currency;
  items: StorefrontReceiptItem[];
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
}

// Every field is picked by name, so a column added to the order later is
// invisible here until someone decides it belongs on a receipt.
export function toStorefrontReceipt(row: OrderDetailRow): StorefrontReceipt {
  return {
    id: formatPublicId('ORD', row.number),
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    currency: row.currency,
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
    total: toAmount(row.total),
  };
}
