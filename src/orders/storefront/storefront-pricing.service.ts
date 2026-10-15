import { Injectable } from '@nestjs/common';
import { formatPublicId } from '../../common/public-id';
import { toAmount } from '../../common/money';
import { Prisma, type Currency } from '../../generated/prisma/client';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import {
  DEFAULT_BAG_CURRENCY,
  eligibleProduct,
  storefrontStockedProductColumns,
  type StorefrontStockedProductRow,
} from '../../products/storefront/storefront-catalog';
import {
  toStorefrontProduct,
  type StorefrontProductDto,
} from '../../products/storefront/storefront-product.mapper';
import { priceOrder } from '../order-pricing';
import type { BagLine } from './bag-engine';

/**
 * Why a line cannot be bought as it stands. `CURRENCY_MISMATCH`: it is priced
 * in a different currency from the bag's first product, and an order has one.
 */
export type LineIssue =
  'PRODUCT_UNAVAILABLE' | 'INSUFFICIENT_STOCK' | 'CURRENCY_MISMATCH';

export interface PricedLine {
  /** Public id, "PRD-<number>". */
  productId: string;
  number: number;
  quantity: number;
  /** Null when the product is not for sale: nothing about it is revealed. */
  product: StorefrontProductDto | null;
  unitPrice: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal | null;
  issue: LineIssue | null;
}

export interface PricedBag {
  currency: Currency;
  lines: PricedLine[];
  /** The sum of the priced lines' totals; lines that are not for sale add nothing. */
  subtotal: Prisma.Decimal;
  /** Distinct products. */
  lineCount: number;
  /** Units across all lines. */
  unitCount: number;
  hasIssues: boolean;
}

/**
 * The currency of a bag: that of its first product that is for sale, in bag
 * order, or the default for a bag with none.
 */
function bagCurrency(
  numbers: readonly number[],
  rows: ReadonlyMap<number, StorefrontStockedProductRow>,
): Currency {
  for (const number of numbers) {
    const row = rows.get(number);
    if (row) return row.currency;
  }
  return DEFAULT_BAG_CURRENCY;
}

/**
 * Prices a bag from the products as they are now, and says which lines cannot
 * be bought. Read-only: it reserves nothing, so what it returns is information,
 * and placing an order prices and takes stock again, atomically.
 */
@Injectable()
export class StorefrontPricingService {
  constructor(private readonly prisma: PrismaService) {}

  async price(
    lines: readonly BagLine[],
    db: Db = this.prisma,
  ): Promise<PricedBag> {
    const rows = await this.load(
      db,
      lines.map((line) => line.number),
    );

    const currency = bagCurrency(
      lines.map((line) => line.number),
      rows,
    );

    const priced: PricedLine[] = lines.map(({ number, quantity }) => {
      const productId = formatPublicId('PRD', number);
      const row = rows.get(number);
      if (!row) {
        return {
          productId,
          number,
          quantity,
          product: null,
          unitPrice: null,
          lineTotal: null,
          issue: 'PRODUCT_UNAVAILABLE',
        };
      }
      if (row.currency !== currency) {
        // Shown, but not priced into this bag: it would need its own order.
        return {
          productId,
          number,
          quantity,
          product: toStorefrontProduct(row),
          unitPrice: null,
          lineTotal: null,
          issue: 'CURRENCY_MISMATCH',
        };
      }
      return {
        productId,
        number,
        quantity,
        product: toStorefrontProduct(row),
        unitPrice: new Prisma.Decimal(row.price),
        lineTotal: null, // filled in below, with exact decimals
        issue: quantity > row.stock ? 'INSUFFICIENT_STOCK' : null,
      };
    });

    const forSale = priced.filter((line) => line.unitPrice !== null);
    const { lineTotals, subtotal } = priceOrder(
      forSale.map((line) => ({
        unitPrice: line.unitPrice as Prisma.Decimal,
        quantity: line.quantity,
      })),
      {
        shipping: new Prisma.Decimal(0),
        discount: new Prisma.Decimal(0),
        tax: new Prisma.Decimal(0),
      },
    );
    forSale.forEach((line, index) => {
      line.lineTotal = lineTotals[index];
    });

    return {
      currency,
      lines: priced,
      subtotal,
      lineCount: priced.length,
      unitCount: priced.reduce((units, line) => units + line.quantity, 0),
      hasIssues: priced.some((line) => line.issue !== null),
    };
  }

  /**
   * Whether `quantity` of one product can be bought right now, in the bag it
   * would be part of (`bagNumbers`, in bag order, including `number`): null when
   * it can. Used to refuse an action that would put something unbuyable in the
   * bag.
   */
  async issueFor(
    number: number,
    quantity: number,
    bagNumbers: readonly number[],
    db: Db = this.prisma,
  ): Promise<LineIssue | null> {
    const rows = await this.load(db, [number, ...bagNumbers]);
    const row = rows.get(number);
    if (!row) return 'PRODUCT_UNAVAILABLE';
    if (row.currency !== bagCurrency(bagNumbers, rows)) {
      return 'CURRENCY_MISMATCH';
    }
    return quantity > row.stock ? 'INSUFFICIENT_STOCK' : null;
  }

  private async load(
    db: Db,
    numbers: number[],
  ): Promise<Map<number, StorefrontStockedProductRow>> {
    if (numbers.length === 0) return new Map();
    const rows = await db.$queryRaw<StorefrontStockedProductRow[]>`
      SELECT ${storefrontStockedProductColumns}
      FROM "Product" p
      JOIN "Category" c ON c."id" = p."categoryId"
      WHERE p."number" = ANY(${numbers}::int[]) AND ${eligibleProduct}`;
    return new Map(rows.map((row) => [row.number, row]));
  }
}

/** A priced line as a response shows it. `toAmount` is the only conversion. */
export function toLineResponse(line: PricedLine) {
  return {
    productId: line.productId,
    quantity: line.quantity,
    product: line.product,
    unitPrice: line.unitPrice === null ? null : toAmount(line.unitPrice),
    lineTotal: line.lineTotal === null ? null : toAmount(line.lineTotal),
    issue: line.issue,
  };
}
