import type {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../generated/prisma/client';

/**
 * Where an order may go next. Forward only: an order is never put back, and
 * shipping may skip PROCESSING (packed and sent in one go). DELIVERED and
 * CANCELLED are final.
 *
 * Returns and refunds as flows are not part of this release, so a shipped order
 * cannot be cancelled. That includes a cash-on-delivery parcel that was refused
 * at the door: it needs a returns flow (and a decision about its stock) that
 * does not exist yet.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PROCESSING', 'SHIPPED', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const LABELS: Record<OrderStatus, string> = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

/**
 * Whether an order with this payment may be at `to`, a status that needs one
 * (SHIPPED or DELIVERED). It mirrors the database CHECK
 * "Order_payment_consistency_check", which is the backstop.
 *
 * Cash on delivery is collected when the parcel arrives, so a COD order may
 * ship while its payment is PENDING. Shipping never implies payment: staff
 * record it when the cash is in. DELIVERED always needs PAID, and an order
 * without a method (legacy or unspecified) must be paid before it ships.
 */
function paymentAllows(
  to: OrderStatus,
  paymentStatus: PaymentStatus,
  paymentMethod: PaymentMethod | null,
): boolean {
  if (paymentStatus === 'PAID') return true;
  return (
    to === 'SHIPPED' && paymentMethod === 'COD' && paymentStatus === 'PENDING'
  );
}

/**
 * Why `from` cannot become `to` for an order with this payment status and
 * method, written for the person who asked; null when the change is allowed.
 * Moving to the status it already has is not a change, and is for the caller to
 * treat as done.
 */
export function describeInvalidTransition(
  from: OrderStatus,
  to: OrderStatus,
  paymentStatus: PaymentStatus,
  paymentMethod: PaymentMethod | null,
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
  if (
    (to === 'SHIPPED' || to === 'DELIVERED') &&
    !paymentAllows(to, paymentStatus, paymentMethod)
  ) {
    if (paymentMethod === 'COD') {
      return `Record the cash payment before marking a cash-on-delivery order as ${LABELS[to]}.`;
    }
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
