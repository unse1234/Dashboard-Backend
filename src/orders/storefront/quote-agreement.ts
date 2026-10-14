import type { Prisma } from '../../generated/prisma/client';
import type { BagLine } from './bag-engine';
import { DEMO_CHARGES, normalizeRegion } from './quote-claims';
import type { QuoteClaims } from './quote-token.service';

/** What differs between the quote the guest reviewed and the order to place. */
export type QuoteMismatch =
  /** The bag is not the one that was quoted. */
  | 'ITEMS_CHANGED'
  /** The delivery province is not the one that was quoted. */
  | 'DESTINATION_CHANGED'
  /** A unit price is not what it was when the guest reviewed it. */
  | 'PRICES_CHANGED'
  /** The charges or the amount payable are not what was quoted. */
  | 'TOTAL_CHANGED';

/**
 * Whether the order as requested is the one the quote was issued for. Checked
 * before anything is written, from the request alone.
 */
export function requestMismatch(
  claims: QuoteClaims,
  lines: readonly BagLine[],
  region: string,
): QuoteMismatch | null {
  const sorted = [...lines].sort((a, b) => a.number - b.number);
  const sameItems =
    sorted.length === claims.items.length &&
    sorted.every(
      ({ number, quantity }, index) =>
        claims.items[index][0] === number &&
        claims.items[index][1] === quantity,
    );
  if (!sameItems) return 'ITEMS_CHANGED';
  if (claims.destination.region !== normalizeRegion(region)) {
    return 'DESTINATION_CHANGED';
  }
  return null;
}

/**
 * Whether the order as it would be priced right now (from the stock actually
 * taken) is still what the quote promised, to the cent. A quote never lets an
 * order go through at a different amount.
 */
export function pricedMismatch(
  claims: QuoteClaims,
  priced: {
    lines: readonly { number: number; unitPrice: Prisma.Decimal }[];
    subtotal: Prisma.Decimal;
    total: Prisma.Decimal;
  },
): QuoteMismatch | null {
  const sorted = [...priced.lines].sort((a, b) => a.number - b.number);
  const samePrices =
    sorted.length === claims.unitPrices.length &&
    sorted.every(
      ({ unitPrice }, index) =>
        unitPrice.toFixed(2) === claims.unitPrices[index],
    );
  if (!samePrices) return 'PRICES_CHANGED';

  const sameAmounts =
    claims.subtotal === priced.subtotal.toFixed(2) &&
    claims.shipping === DEMO_CHARGES.shipping.toFixed(2) &&
    claims.tax === DEMO_CHARGES.tax.toFixed(2) &&
    claims.discount === DEMO_CHARGES.discount.toFixed(2) &&
    claims.total === priced.total.toFixed(2);
  return sameAmounts ? null : 'TOTAL_CHANGED';
}
