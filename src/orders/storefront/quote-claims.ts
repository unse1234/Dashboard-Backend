import { Prisma } from '../../generated/prisma/client';
import type { PriceAdjustments } from '../order-pricing';
import { DELIVERY_COUNTRY } from './dto/storefront-address.dto';
import type { QuoteClaims } from './quote-token.service';

/**
 * Shipping, tax and discount for this demo: explicitly zero. This is a demo
 * configuration, not a statement about what a live store owes. When a charge
 * starts to depend on the destination, it belongs here, and the bag (which has
 * no address) must then report it as pending instead of zero.
 */
export const DEMO_CHARGES: PriceAdjustments = {
  shipping: new Prisma.Decimal(0),
  tax: new Prisma.Decimal(0),
  discount: new Prisma.Decimal(0),
};

/** A region compared the way a person would: case and spacing aside. */
export const normalizeRegion = (region: string): string =>
  region.trim().replace(/\s+/g, ' ').toLowerCase();

export interface QuotedLine {
  number: number;
  quantity: number;
  unitPrice: Prisma.Decimal;
}

/**
 * What a quote binds: the canonical items (order-independent, so the same bag
 * in another order is the same quote), their unit prices, the destination data
 * a charge could depend on, and the amounts.
 */
export function buildQuoteClaims(
  lines: readonly QuotedLine[],
  amounts: { subtotal: Prisma.Decimal; total: Prisma.Decimal },
  charges: PriceAdjustments,
  destination: { region: string },
): QuoteClaims {
  const sorted = [...lines].sort((a, b) => a.number - b.number);
  return {
    currency: 'PKR',
    items: sorted.map(({ number, quantity }) => [number, quantity]),
    unitPrices: sorted.map(({ unitPrice }) => unitPrice.toFixed(2)),
    destination: {
      country: DELIVERY_COUNTRY,
      region: normalizeRegion(destination.region),
    },
    subtotal: amounts.subtotal.toFixed(2),
    shipping: charges.shipping.toFixed(2),
    tax: charges.tax.toFixed(2),
    discount: charges.discount.toFixed(2),
    total: amounts.total.toFixed(2),
  };
}
