import { Injectable } from '@nestjs/common';
import { formatPublicId } from '../../common/public-id';
import { toAmount } from '../../common/money';
import { Prisma, type Currency } from '../../generated/prisma/client';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import { UploadsService } from '../../uploads/uploads.service';
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

/** Why a line cannot be bought. CURRENCY_MISMATCH is retained for API compatibility. */
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
 * Prices a bag from the products as they are now, and says which lines cannot
 * be bought. Read-only: it reserves nothing, so what it returns is information,
 * and placing an order prices and takes stock again, atomically.
 */
@Injectable()
export class StorefrontPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  async price(
    lines: readonly BagLine[],
    db: Db = this.prisma,
  ): Promise<PricedBag> {
    const rows = await this.load(
      db,
      lines.map((line) => line.number),
    );

    const currency = DEFAULT_BAG_CURRENCY;

    const priced: PricedLine[] = lines.map(({ number, quantity }) => {
      const productId = formatPublicId('PRD', number);
      const row = rows.get(number);
      if (!row || row.currency !== currency) {
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
      return {
        productId,
        number,
        quantity,
        product: toStorefrontProduct(row, (reference) =>
          this.uploads.publicUrl(reference),
        ),
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
