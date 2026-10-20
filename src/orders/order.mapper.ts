import { toAmount, type MoneyValue } from '../common/money';
import { formatPublicId } from '../common/public-id';
import type {
  Currency,
  OrderConfirmationStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client';

/**
 * The customer as the order recorded them, so an order keeps reading the same
 * if the customer later changes their details.
 */
export interface OrderCustomerDto {
  /** Public id, "CUS-<number>". */
  id: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface OrderAddressDto {
  recipientName: string;
  phone: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  country: string;
}

/** A line of the order, with the product as it was when the order was placed. */
export interface OrderItemDto {
  id: string;
  /** The product's public id, "PRD-<number>". */
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  /** In the order's currency. */
  unitPrice: number;
  /** quantity x unitPrice, in the order's currency. */
  total: number;
}

/**
 * Where an order stands on email confirmation, for staff. Null for an order
 * that never needed one (every order placed before it, and staff orders).
 * While AWAITING_CONFIRMATION the order cannot be processed, shipped,
 * cancelled or marked paid; past its deadline it is cancelled (EXPIRED).
 */
export type OrderEmailConfirmationDto = {
  status: Exclude<OrderConfirmationStatus, 'EXEMPT'>;
  /** ISO 8601: the deadline (the stock is held until then). */
  expiresAt: string;
  /** ISO 8601, once confirmed. */
  confirmedAt: string | null;
} | null;

export interface OrderListItemDto {
  /** Public id, "ORD-<number>". */
  id: string;
  customer: OrderCustomerDto;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /** How it is paid for; null on orders that predate payment methods. */
  paymentMethod: PaymentMethod | null;
  /** What every amount of the order is denominated in. */
  currency: Currency;
  /** Units across all lines. */
  itemCount: number;
  /** In `currency`. */
  total: number;
  /** ISO 8601. */
  createdAt: string;
  emailConfirmation: OrderEmailConfirmationDto;
}

export interface OrderDto extends OrderListItemDto {
  items: OrderItemDto[];
  /** All amounts are in `currency`. */
  subtotal: number;
  shipping: number;
  /** Taken off, as a positive number. */
  discount: number;
  tax: number;
  shippingAddress: OrderAddressDto;
  billingAddress: OrderAddressDto;
  /** ISO 8601. */
  updatedAt: string;
}

/** A row of the list query in orders.service.ts. */
export interface OrderListRow {
  number: number;
  customerNumber: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  currency: Currency;
  itemCount: number;
  total: MoneyValue;
  createdAt: Date;
  confirmationStatus: OrderConfirmationStatus;
  confirmationExpiresAt: Date | null;
  confirmedAt: Date | null;
}

// Each mapper lists its fields explicitly, so internal columns (uuids, the
// idempotency key and its request hash) never reach a response.
export const orderDetailSelect = {
  id: true,
  number: true,
  customer: { select: { number: true } },
  customerName: true,
  customerEmail: true,
  customerPhone: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  currency: true,
  itemCount: true,
  subtotal: true,
  shipping: true,
  discount: true,
  tax: true,
  total: true,
  shippingAddress: true,
  billingAddress: true,
  // Email confirmation: the storefront's answers, and the admin DTO's emailConfirmation.
  confirmationStatus: true,
  confirmationEmail: true,
  confirmationExpiresAt: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      productId: true,
      productName: true,
      sku: true,
      quantity: true,
      unitPrice: true,
      total: true,
    },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.OrderSelect;

export type OrderDetailRow = Prisma.OrderGetPayload<{
  select: typeof orderDetailSelect;
}>;

function toCustomer(row: {
  customerNumber: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
}): OrderCustomerDto {
  return {
    id: formatPublicId('CUS', row.customerNumber),
    name: row.customerName,
    email: row.customerEmail,
    phone: row.customerPhone,
  };
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Reads an address snapshot, which is stored as JSON, field by field. */
export function toAddress(value: Prisma.JsonValue): OrderAddressDto {
  const json =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : {};
  return {
    recipientName: text(json.recipientName),
    phone: optionalText(json.phone),
    addressLine1: text(json.addressLine1),
    addressLine2: optionalText(json.addressLine2),
    city: text(json.city),
    region: optionalText(json.region),
    postalCode: optionalText(json.postalCode),
    country: text(json.country),
  };
}

export function toOrderListItem(row: OrderListRow): OrderListItemDto {
  return {
    id: formatPublicId('ORD', row.number),
    customer: toCustomer(row),
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    currency: row.currency,
    itemCount: row.itemCount,
    total: toAmount(row.total),
    createdAt: row.createdAt.toISOString(),
    emailConfirmation: toEmailConfirmation(row),
  };
}

function toEmailConfirmation(
  row: Pick<
    OrderListRow,
    'confirmationStatus' | 'confirmationExpiresAt' | 'confirmedAt'
  >,
): OrderEmailConfirmationDto {
  if (row.confirmationStatus === 'EXEMPT' || !row.confirmationExpiresAt) {
    return null;
  }
  return {
    status: row.confirmationStatus,
    expiresAt: row.confirmationExpiresAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

export function toOrderDto(row: OrderDetailRow): OrderDto {
  return {
    ...toOrderListItem({
      number: row.number,
      customerNumber: row.customer.number,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      customerPhone: row.customerPhone,
      status: row.status,
      paymentStatus: row.paymentStatus,
      paymentMethod: row.paymentMethod,
      currency: row.currency,
      itemCount: row.itemCount,
      total: row.total,
      createdAt: row.createdAt,
      confirmationStatus: row.confirmationStatus,
      confirmationExpiresAt: row.confirmationExpiresAt,
      confirmedAt: row.confirmedAt,
    }),
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: toAmount(item.unitPrice),
      total: toAmount(item.total),
    })),
    subtotal: toAmount(row.subtotal),
    shipping: toAmount(row.shipping),
    discount: toAmount(row.discount),
    tax: toAmount(row.tax),
    shippingAddress: toAddress(row.shippingAddress),
    billingAddress: toAddress(row.billingAddress),
    updatedAt: row.updatedAt.toISOString(),
  };
}
