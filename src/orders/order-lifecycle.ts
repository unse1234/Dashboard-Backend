import type { OrderStatus, PaymentStatus } from '../generated/prisma/client';

/**
 * Where an order may go next. Forward only: an order is never put back, and
 * shipping may skip PROCESSING (packed and sent in one go). DELIVERED and
 * CANCELLED are final.
 *
 * Returns and refunds as flows are not part of this release, so a shipped order
 * cannot be cancelled.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PROCESSING', 'SHIPPED', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Statuses an order may only reach once it has been paid. */
export const STATUSES_REQUIRING_PAYMENT: readonly OrderStatus[] = [
  'SHIPPED',
  'DELIVERED',
];

const LABELS: Record<OrderStatus, string> = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

/**
 * Why `from` cannot become `to` for an order with this payment status, written
 * for the person who asked; null when the change is allowed. Moving to the
 * status it already has is not a change, and is for the caller to treat as done.
 */
export function describeInvalidTransition(
  from: OrderStatus,
  to: OrderStatus,
  paymentStatus: PaymentStatus,
): string | null {
  if (from === 'DELIVERED' || from === 'CANCELLED') {
    return `A ${LABELS[from]} order can't change status.`;
  }
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    if (to === 'CANCELLED') {
      return `A ${LABELS[from]} order can't be cancelled.`;
    }
    return `An order can't go from ${LABELS[from]} to ${LABELS[to]}.`;
  }
  if (STATUSES_REQUIRING_PAYMENT.includes(to) && paymentStatus !== 'PAID') {
    return `An order can only be marked as ${LABELS[to]} once it has been paid.`;
  }
  return null;
}

/**
 * What the payment status becomes when an order moves to `to`: cancelling an
 * order that was paid records the payment as refunded (the refund itself is
 * made outside the dashboard). Otherwise it stays as it is.
 */
export function paymentStatusAfter(
  to: OrderStatus,
  paymentStatus: PaymentStatus,
): PaymentStatus {
  return to === 'CANCELLED' && paymentStatus === 'PAID'
    ? 'REFUNDED'
    : paymentStatus;
}
