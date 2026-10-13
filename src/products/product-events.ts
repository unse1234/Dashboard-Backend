import { formatPublicId } from '../common/public-id';
import type {
  Currency,
  Prisma,
  ProductEventType,
  ProductStatus,
} from '../generated/prisma/client';

/** The details whose change is recorded as one "Details updated" entry. */
export type ProductDetailField =
  'name' | 'sku' | 'subtitle' | 'brand' | 'description' | 'images' | 'category';

export type StockChangeReason = 'MANUAL' | 'ORDER_PLACED' | 'ORDER_CANCELLED';

/**
 * What is stored in `ProductEvent.data` for each event type. Plain type aliases
 * (not interfaces) so that they are assignable to Prisma's JSON input type.
 */
export type ProductEventPayload =
  | { type: 'CREATED'; data: Record<string, never> }
  | { type: 'DETAILS_UPDATED'; data: { fields: ProductDetailField[] } }
  | {
      type: 'PRICE_CHANGED';
      // One event per price, so each reads as a single sentence.
      data: {
        field: 'price' | 'costPrice';
        from: number | null;
        to: number | null;
        /** What `to` is in. Entries written before currencies existed have none (USD). */
        currency?: Currency;
        /** What `from` was in, only when the currency itself changed. */
        fromCurrency?: Currency;
      };
    }
  | { type: 'STATUS_CHANGED'; data: { from: ProductStatus; to: ProductStatus } }
  | {
      type: 'STOCK_CHANGED';
      data: {
        from: number;
        to: number;
        reason: StockChangeReason;
        /** The order that caused it, for ORDER_PLACED and ORDER_CANCELLED. */
        orderNumber?: number;
      };
    }
  | { type: 'ARCHIVED'; data: Record<string, never> };

/** The columns a product's history is derived from. */
export interface ProductSnapshot {
  name: string;
  sku: string;
  subtitle: string | null;
  brand: string | null;
  description: string | null;
  imageUrl: string | null;
  galleryUrls: string[];
  categoryId: string;
  status: ProductStatus;
  price: Prisma.Decimal;
  currency: Currency;
  costPrice: Prisma.Decimal | null;
  stock: number;
}

const sameImages = (before: ProductSnapshot, after: ProductSnapshot) =>
  before.imageUrl === after.imageUrl &&
  before.galleryUrls.length === after.galleryUrls.length &&
  before.galleryUrls.every((url, index) => url === after.galleryUrls[index]);

const sameAmount = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) =>
  a === null || b === null ? a === b : a.equals(b);

/** The events that turn `before` into `after`; empty when nothing changed. */
export function diffProduct(
  before: ProductSnapshot,
  after: ProductSnapshot,
): ProductEventPayload[] {
  const events: ProductEventPayload[] = [];

  const fields: ProductDetailField[] = [];
  if (before.name !== after.name) fields.push('name');
  if (before.sku !== after.sku) fields.push('sku');
  if (before.subtitle !== after.subtitle) fields.push('subtitle');
  if (before.brand !== after.brand) fields.push('brand');
  if (before.description !== after.description) fields.push('description');
  if (!sameImages(before, after)) fields.push('images');
  if (before.categoryId !== after.categoryId) fields.push('category');
  if (fields.length > 0) {
    events.push({ type: 'DETAILS_UPDATED', data: { fields } });
  }

  // Relabelling the currency is a price change even when the number is the
  // same: 10.00 USD and 10.00 PKR are not the same price.
  const currencyChanged = before.currency !== after.currency;
  const currencyData = {
    currency: after.currency,
    ...(currencyChanged ? { fromCurrency: before.currency } : {}),
  };
  if (currencyChanged || !sameAmount(before.price, after.price)) {
    events.push({
      type: 'PRICE_CHANGED',
      data: {
        field: 'price',
        from: before.price.toNumber(),
        to: after.price.toNumber(),
        ...currencyData,
      },
    });
  }
  if (currencyChanged || !sameAmount(before.costPrice, after.costPrice)) {
    // Not worth an entry when the product has no cost price before or after.
    if (before.costPrice !== null || after.costPrice !== null) {
      events.push({
        type: 'PRICE_CHANGED',
        data: {
          field: 'costPrice',
          from: before.costPrice?.toNumber() ?? null,
          to: after.costPrice?.toNumber() ?? null,
          ...currencyData,
        },
      });
    }
  }

  if (before.status !== after.status) {
    events.push({
      type: 'STATUS_CHANGED',
      data: { from: before.status, to: after.status },
    });
  }

  if (before.stock !== after.stock) {
    events.push({
      type: 'STOCK_CHANGED',
      data: { from: before.stock, to: after.stock, reason: 'MANUAL' },
    });
  }

  return events;
}

/** Rows ready for `productEvent.createMany`. A null actor reads as "System". */
export function toEventRows(
  productId: string,
  actorId: string | null,
  events: ProductEventPayload[],
): Prisma.ProductEventCreateManyInput[] {
  return events.map(({ type, data }) => ({ productId, type, data, actorId }));
}

// --- Wording ---------------------------------------------------------------
// Fixed locale, like the dashboard's own formatting, so the text does not depend
// on the server's settings. The currency is the one the entry was written with;
// entries from before currencies existed are USD.

const currencyFormats: Record<Currency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
  PKR: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'PKR' }),
};
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const STATUS_LABELS: Record<ProductStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

const FIELD_LABELS: Record<ProductDetailField, string> = {
  name: 'name',
  sku: 'SKU',
  subtitle: 'subtitle',
  brand: 'brand',
  description: 'description',
  images: 'images',
  category: 'category',
};

const currencyOf = (value: unknown): Currency =>
  value === 'PKR' || value === 'USD' ? value : 'USD';
// Intl puts a no-break space between a currency code and the number ("PKR 2,800.00").
const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const amountText = (value: unknown, currency: Currency) =>
  typeof value === 'number'
    ? currencyFormats[currency].format(value).split(NO_BREAK_SPACE).join(' ')
    : 'Not set';
const countText = (value: unknown) =>
  typeof value === 'number' ? integer.format(value) : '?';
/** "ORD-10002", or null when the event does not say which order. */
const orderId = (value: unknown) =>
  typeof value === 'number' ? formatPublicId('ORD', value) : null;

/**
 * The sentence the History tab shows for a stored event. `data` came out of a
 * JSON column, so nothing about its shape is trusted: an entry written by some
 * other version still reads sensibly.
 */
export function describeEvent(type: ProductEventType, raw: unknown): string {
  const data =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  switch (type) {
    case 'CREATED':
      return 'Product created';
    case 'ARCHIVED':
      return 'Product archived';
    case 'DETAILS_UPDATED': {
      const fields = Array.isArray(data.fields)
        ? data.fields
            .filter(
              (field): field is ProductDetailField =>
                typeof field === 'string' &&
                Object.prototype.hasOwnProperty.call(FIELD_LABELS, field),
            )
            .map((field) => FIELD_LABELS[field])
        : [];
      return fields.length > 0
        ? `Details updated: ${fields.join(', ')}`
        : 'Details updated';
    }
    case 'PRICE_CHANGED': {
      const label = data.field === 'costPrice' ? 'Cost price' : 'Price';
      const to = currencyOf(data.currency);
      const from =
        data.fromCurrency === undefined ? to : currencyOf(data.fromCurrency);
      return `${label} changed from ${amountText(data.from, from)} to ${amountText(data.to, to)}`;
    }
    case 'STATUS_CHANGED': {
      const label = (value: unknown) =>
        value === 'ACTIVE' || value === 'INACTIVE'
          ? STATUS_LABELS[value]
          : 'Unknown';
      return `Status changed from ${label(data.from)} to ${label(data.to)}`;
    }
    case 'STOCK_CHANGED': {
      const from = countText(data.from);
      const to = countText(data.to);
      const order = orderId(data.orderNumber);
      switch (data.reason) {
        case 'ORDER_PLACED':
          return `Stock reduced from ${from} to ${to} by ${order ? `order ${order}` : 'an order'}`;
        case 'ORDER_CANCELLED':
          return `Stock restored from ${from} to ${to} (${order ? `order ${order}` : 'an order'} cancelled)`;
        default:
          return `Stock updated from ${from} to ${to}`;
      }
    }
  }
}
