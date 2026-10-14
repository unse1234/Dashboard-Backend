import type {
  AddressType,
  Currency,
  OrderStatus,
  Prisma,
} from '../generated/prisma/client';
import { toAmount } from '../common/money';
import { toAddress, type OrderAddressDto } from '../orders/order.mapper';
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
  /**
   * Sum of the totals of orders that were not cancelled, with every currency
   * added together as a bare number: only meaningful while a customer has orders
   * in one currency, and kept for sorting. Show `spentByCurrency`.
   */
  totalSpent: number;
  /**
   * The same, per currency, so amounts of different currencies are never added
   * together. Only currencies the customer has orders in; ordered by currency.
   */
  spentByCurrency: { currency: Currency; amount: number }[];
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

/**
 * An address a customer's orders were delivered to, as the order recorded it.
 *
 * A guest checkout saves no `CustomerAddress` (the address lives only on the
 * order, so a visitor can never write to an existing customer's profile by
 * typing their email). This is how staff see those addresses on the customer.
 */
export interface CustomerOrderAddressDto {
  address: OrderAddressDto;
  /** ISO 8601: when the newest order that used this address was placed. */
  lastUsedAt: string;
  /** How many of the customer's orders were delivered to it. */
  orderCount: number;
}

export interface CustomerDetailsDto {
  customer: CustomerListItem;
  /** What the customer saved, grouped by the page. */
  addresses: CustomerAddressDto[];
  /** Where their orders were delivered, newest first; see the type. */
  orderAddresses: CustomerOrderAddressDto[];
  recentOrders: CustomerOrderSummaryDto[];
}

/** A row of the delivery-address query in customers.service.ts. */
export interface CustomerOrderAddressRow {
  address: Prisma.JsonValue;
  lastUsedAt: Date;
  orderCount: number;
}

export function toCustomerOrderAddress(
  row: CustomerOrderAddressRow,
): CustomerOrderAddressDto {
  return {
    address: toAddress(row.address),
    lastUsedAt: row.lastUsedAt.toISOString(),
    orderCount: row.orderCount,
  };
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
  /** { "PKR": "6499.50", "USD": "120.00" }: decimals as text, to stay exact. */
  spentByCurrency: Record<string, string> | null;
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
    spentByCurrency: Object.entries(row.spentByCurrency ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({
        currency: currency as Currency,
        amount: toAmount(amount),
      })),
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
