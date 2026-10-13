import type {
  AddressType,
  Currency,
  OrderStatus,
  Prisma,
} from '../generated/prisma/client';
import { toAmount } from '../common/money';
import { formatCustomerId, formatOrderId } from './customer-id';

/** A customer as the list and the details page show it. */
export interface CustomerListItem {
  /** Public id, "CUS-<number>". */
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** ISO 8601. */
  joinedAt: string;
  /** All orders, cancelled ones included. */
  totalOrders: number;
  /** Sum of the totals of orders that were not cancelled, in USD. */
  totalSpent: number;
  /** ISO 8601; null until the first order. */
  lastOrderAt: string | null;
}

export interface CustomerAddressDto {
  id: string;
  customerId: string;
  type: AddressType;
  recipientName: string;
  phone: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  country: string;
  isDefault: boolean;
}

export interface CustomerOrderSummaryDto {
  /** Public id, "ORD-<number>". */
  id: string;
  customerId: string;
  /** In `currency`. */
  total: number;
  /** What `total` is denominated in. */
  currency: Currency;
  status: OrderStatus;
  /** ISO 8601. */
  createdAt: string;
}

export interface CustomerDetailsDto {
  customer: CustomerListItem;
  addresses: CustomerAddressDto[];
  recentOrders: CustomerOrderSummaryDto[];
}

/** A row of the customer query in customers.service.ts. */
export interface CustomerRow {
  id: string;
  number: number;
  name: string;
  email: string;
  phone: string | null;
  createdAt: Date;
  totalOrders: number;
  totalSpent: Prisma.Decimal | string | number;
  lastOrderAt: Date | null;
}

// Each mapper lists its fields explicitly, so internal columns such as the
// uuid never reach a response.
export function toCustomerListItem(row: CustomerRow): CustomerListItem {
  return {
    id: formatCustomerId(row.number),
    name: row.name,
    email: row.email,
    phone: row.phone,
    joinedAt: row.createdAt.toISOString(),
    totalOrders: row.totalOrders,
    totalSpent: toAmount(row.totalSpent),
    lastOrderAt: row.lastOrderAt ? row.lastOrderAt.toISOString() : null,
  };
}

export const customerAddressSelect = {
  id: true,
  type: true,
  recipientName: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
  isDefault: true,
} satisfies Prisma.CustomerAddressSelect;

export function toCustomerAddress(
  customerNumber: number,
  address: Prisma.CustomerAddressGetPayload<{
    select: typeof customerAddressSelect;
  }>,
): CustomerAddressDto {
  return {
    id: address.id,
    customerId: formatCustomerId(customerNumber),
    type: address.type,
    recipientName: address.recipientName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    isDefault: address.isDefault,
  };
}

export const orderSummarySelect = {
  number: true,
  total: true,
  currency: true,
  status: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;

export function toCustomerOrderSummary(
  customerNumber: number,
  order: Prisma.OrderGetPayload<{ select: typeof orderSummarySelect }>,
): CustomerOrderSummaryDto {
  return {
    id: formatOrderId(order.number),
    customerId: formatCustomerId(customerNumber),
    total: toAmount(order.total),
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
  };
}
