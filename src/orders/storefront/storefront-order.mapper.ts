import { toAmount } from '../../common/money';
import type {
  Currency,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../generated/prisma/client';
import { formatPublicId } from '../../common/public-id';
import {
  toAddress,
  type OrderAddressDto,
  type OrderDetailRow,
} from '../order.mapper';

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

/**
 * The answer to a placement while email confirmation is on: the order is
 * waiting for its buyer, and this says where the link went and until when.
 *
 * It is not a receipt. There is no order reference, no address and no contact
 * detail: an order counts only once its email is confirmed, and nothing here is
 * worth reading by anyone but the buyer. `receiptToken` is the guest's narrow
 * credential for this order's confirmation status and for asking for the email
 * again; it shows nothing else and confirms nothing.
 */
export interface StorefrontConfirmationRequired {
  outcome: 'CONFIRMATION_REQUIRED';
  confirmation: {
    status: 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'EXPIRED';
    /** The address the link was sent to, as the buyer typed it (lower-cased). */
    email: string;
    /** ISO 8601. The order must be confirmed before this. */
    expiresAt: string;
    /** "cr_…"; null once the receipt has run out (a day after the deadline). */
    receiptToken: string | null;
  };
  /** What was ordered and what it costs: the receipt's amounts, nothing else. */
  order: Pick<
    StorefrontReceipt,
    | 'currency'
    | 'paymentMethod'
    | 'items'
    | 'subtotal'
    | 'shipping'
    | 'tax'
    | 'discount'
    | 'total'
  >;
}

/** What POST /storefront/orders answers: a receipt, or "confirm it first". */
export type StorefrontPlacement =
  StorefrontReceipt | StorefrontConfirmationRequired;

export function toConfirmationRequired(
  row: OrderDetailRow,
  receiptToken: string | null,
  now: Date = new Date(),
): StorefrontConfirmationRequired {
  if (
    row.confirmationStatus === 'EXEMPT' ||
    !row.confirmationEmail ||
    !row.confirmationExpiresAt
  ) {
    throw new Error('The order did not need confirmation');
  }
  return {
    outcome: 'CONFIRMATION_REQUIRED',
    confirmation: {
      status: confirmationStateOf(row, now) ?? 'EXPIRED',
      email: row.confirmationEmail,
      expiresAt: row.confirmationExpiresAt.toISOString(),
      receiptToken,
    },
    order: toOrderSummary(row),
  };
}

export type ConfirmationState =
  'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'EXPIRED';

/**
 * Where an order stands on confirmation now. Past its deadline it can no
 * longer be confirmed, whether or not the expiry has run yet. Null for an
 * order that never needed confirmation.
 */
export function confirmationStateOf(
  row: Pick<OrderDetailRow, 'confirmationStatus' | 'confirmationExpiresAt'>,
  now: Date = new Date(),
): ConfirmationState | null {
  switch (row.confirmationStatus) {
    case 'EXEMPT':
      return null;
    case 'CONFIRMED':
    case 'EXPIRED':
      return row.confirmationStatus;
    case 'AWAITING_CONFIRMATION':
      return row.confirmationExpiresAt && row.confirmationExpiresAt > now
        ? 'AWAITING_CONFIRMATION'
        : 'EXPIRED';
  }
}

/** What was ordered and what it costs: the receipt's amounts, nothing else. */
function toOrderSummary(
  row: OrderDetailRow,
): StorefrontConfirmationRequired['order'] {
  const receipt = toStorefrontReceipt(row);
  return {
    currency: receipt.currency,
    paymentMethod: receipt.paymentMethod,
    items: receipt.items,
    subtotal: receipt.subtotal,
    shipping: receipt.shipping,
    tax: receipt.tax,
    discount: receipt.discount,
    total: receipt.total,
  };
}

/**
 * What a confirmation link shows before anyone presses Confirm. Only while the
 * order can still be confirmed does it say what is being confirmed, and then
 * only the amounts and roughly where it goes; otherwise just how it stands.
 * `LINK_REPLACED`: the order still waits, but a newer email replaced this link.
 */
export type StorefrontConfirmationPreview =
  | {
      status: 'AWAITING_CONFIRMATION';
      /** ISO 8601. */
      expiresAt: string;
      order: StorefrontConfirmationRequired['order'];
      delivery: {
        recipientName: string;
        city: string;
        region: string | null;
        country: string;
      };
    }
  | { status: 'CONFIRMED' | 'EXPIRED' | 'LINK_REPLACED' };

export function toConfirmationPreview(
  row: OrderDetailRow,
  linkReplaced: boolean,
  now: Date = new Date(),
): StorefrontConfirmationPreview {
  const state = confirmationStateOf(row, now) ?? 'EXPIRED';
  if (state !== 'AWAITING_CONFIRMATION') return { status: state };
  if (linkReplaced) return { status: 'LINK_REPLACED' };
  const address = toAddress(row.shippingAddress);
  return {
    status: 'AWAITING_CONFIRMATION',
    expiresAt: row.confirmationExpiresAt!.toISOString(),
    order: toOrderSummary(row),
    delivery: {
      recipientName: address.recipientName,
      city: address.city,
      region: address.region,
      country: address.country,
    },
  };
}

/** What confirming an order offers about a storefront account. */
export type AccountOffer =
  /** No account has this address: one may be created with `setupToken`. */
  | { kind: 'SETUP_AVAILABLE'; setupToken: string; expiresAt: string }
  /** An account has this address: sign in to see the order there. */
  | { kind: 'SIGN_IN' }
  /** Nothing to offer: accounts are off, or the order was already confirmed. */
  | { kind: 'NONE' };

/**
 * The answer to confirming an order (or to confirming it again). The person
 * holding the link has just proven the inbox the order names, so it is the
 * full receipt and the delivery details they typed; nothing about anyone else.
 */
export interface StorefrontConfirmationResult {
  outcome: 'CONFIRMED';
  alreadyConfirmed: boolean;
  order: StorefrontReceipt;
  delivery: {
    contactName: string;
    email: string;
    phone: string | null;
    address: OrderAddressDto;
  };
  account: AccountOffer;
}

export function toConfirmationResult(
  row: OrderDetailRow,
  alreadyConfirmed: boolean,
  account: AccountOffer,
): StorefrontConfirmationResult {
  return {
    outcome: 'CONFIRMED',
    alreadyConfirmed,
    order: toStorefrontReceipt(row),
    delivery: {
      contactName: row.customerName,
      email: row.confirmationEmail ?? row.customerEmail,
      phone: row.customerPhone,
      address: toAddress(row.shippingAddress),
    },
    account,
  };
}

/** What the guest's receipt token tells about their order: how it stands. */
export interface CheckoutReceiptStatus {
  status: ConfirmationState;
  /** ISO 8601: the confirmation deadline. */
  expiresAt: string;
  email: string;
  resend: {
    /** Confirmation emails that may still be asked for. */
    remaining: number;
    /** ISO 8601: when the next may be asked for; null when none may. */
    availableAt: string | null;
  };
}
