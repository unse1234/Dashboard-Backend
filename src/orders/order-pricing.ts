import { Prisma, type Currency } from '../generated/prisma/client';

export interface PricedLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
}

export interface PriceAdjustments {
  shipping: Prisma.Decimal;
  /** Taken off, as a positive amount. */
  discount: Prisma.Decimal;
  tax: Prisma.Decimal;
}

export interface OrderPrice {
  /** Each line's quantity x unit price, in the order of the lines given. */
  lineTotals: Prisma.Decimal[];
  subtotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

/**
 * Prices an order with exact decimals, never floating point:
 * subtotal = the sum of the lines, total = subtotal + shipping - discount + tax.
 * A discount that would take the order below zero is the caller's to reject; the
 * database refuses a negative total as well.
 */
export function priceOrder(
  lines: PricedLine[],
  { shipping, discount, tax }: PriceAdjustments,
): OrderPrice {
  const lineTotals = lines.map(({ unitPrice, quantity }) =>
    unitPrice.times(quantity),
  );
  const subtotal = lineTotals.reduce(
    (sum, lineTotal) => sum.plus(lineTotal),
    new Prisma.Decimal(0),
  );
  const total = subtotal.plus(shipping).minus(discount).plus(tax);
  return { lineTotals, subtotal, total };
}

/** True when the discount is more than the order is worth before it. */
export function exceedsOrderValue(
  { subtotal }: Pick<OrderPrice, 'subtotal'>,
  { shipping, discount, tax }: PriceAdjustments,
): boolean {
  return discount.greaterThan(subtotal.plus(shipping).plus(tax));
}

/**
 * The one currency every line is priced in, or null when the lines mix
 * currencies (or there are none). Amounts in different currencies are never
 * added together, and no exchange rate is applied.
 */
export function commonCurrency(
  currencies: readonly Currency[],
): Currency | null {
  const first = currencies[0];
  if (first === undefined) return null;
  return currencies.every((currency) => currency === first) ? first : null;
}

/**
 * The most an order's subtotal or total can be: what the NUMERIC(12,2) columns
 * hold. Checked before anything is written, so a large bag is refused cleanly
 * instead of failing inside the database.
 */
export const MAX_ORDER_AMOUNT = new Prisma.Decimal('9999999999.99');

/** True when an amount is more than an order can record. */
export function exceedsMaxOrderAmount(amount: Prisma.Decimal): boolean {
  return amount.greaterThan(MAX_ORDER_AMOUNT);
}
