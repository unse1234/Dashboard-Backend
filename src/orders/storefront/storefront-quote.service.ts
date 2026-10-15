import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business-error';
import { toAmount } from '../../common/money';
import { formatPublicId, parsePublicId } from '../../common/public-id';
import type { Currency } from '../../generated/prisma/client';
import { exceedsMaxOrderAmount, priceOrder } from '../order-pricing';
import { applyBagAction, BagRuleError } from './bag-engine';
import { canonicalBag } from './bag-input';
import type { BagQuoteDto, CheckoutQuoteDto } from './dto/bag-quote.dto';
import { isDeliveryCountry } from './dto/storefront-address.dto';
import { buildQuoteClaims, DEMO_CHARGES } from './quote-claims';
import { QuoteTokenService } from './quote-token.service';
import {
  StorefrontPricingService,
  toLineResponse,
  type LineIssue,
} from './storefront-pricing.service';

type LineResponse = ReturnType<typeof toLineResponse>;

export interface BagQuoteResponse {
  currency: Currency;
  /** The canonical bag: what the client keeps, with each line priced. */
  items: LineResponse[];
  /** Of the lines that are for sale. Informational: it reserves no stock. */
  subtotal: number;
  /** Distinct products. */
  lineCount: number;
  /** Units across all lines. */
  unitCount: number;
  /** True when a line cannot be bought as it stands; checkout is blocked. */
  hasIssues: boolean;
}

export interface CheckoutQuoteResponse {
  currency: Currency;
  paymentMethod: 'COD';
  items: LineResponse[];
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
  /** Opaque: store it and send it back with the order. */
  quoteToken: string;
  /** ISO 8601. After this the quote must be renewed. */
  expiresAt: string;
}

const ISSUE_MESSAGES: Record<LineIssue, string> = {
  PRODUCT_UNAVAILABLE: 'This product is no longer available',
  INSUFFICIENT_STOCK: 'There is not enough stock for this quantity',
  CURRENCY_MISMATCH:
    'This product is priced in a different currency from the rest of your bag. A bag holds one currency.',
};

/** The bag and checkout quotes: priced from the products as they are now. */
@Injectable()
export class StorefrontQuoteService {
  constructor(
    private readonly pricing: StorefrontPricingService,
    private readonly tokens: QuoteTokenService,
  ) {}

  /**
   * Validates the bag as sent, applies the action if there is one, and returns
   * the canonical bag priced. Nothing is stored. An action that would put
   * something that cannot be bought into the bag is refused (409) and changes
   * nothing, so the client keeps the bag it had.
   */
  async quoteBag(dto: BagQuoteDto): Promise<BagQuoteResponse> {
    let lines = canonicalBag(dto.items);

    if (dto.action) {
      const { type, productId, quantity } = dto.action;
      // The DTO has already checked that the id is well formed.
      const number = parsePublicId('PRD', productId) as number;

      let applied: ReturnType<typeof applyBagAction>;
      try {
        applied = applyBagAction(lines, { type, number, quantity });
      } catch (error) {
        throw this.invalidBag(error);
      }

      if (applied.raised) {
        const issue = await this.pricing.issueFor(
          applied.raised.number,
          applied.raised.quantity,
          applied.lines.map((line) => line.number),
        );
        if (issue) {
          throw new BusinessException(
            HttpStatus.CONFLICT,
            issue,
            ISSUE_MESSAGES[issue],
            { productId: formatPublicId('PRD', applied.raised.number) },
          );
        }
      }
      lines = applied.lines;
    }

    const bag = await this.pricing.price(lines);
    if (exceedsMaxOrderAmount(bag.subtotal)) throw this.tooLarge();
    return {
      currency: bag.currency,
      items: bag.lines.map(toLineResponse),
      subtotal: toAmount(bag.subtotal),
      lineCount: bag.lineCount,
      unitCount: bag.unitCount,
      hasIssues: bag.hasIssues,
    };
  }

  /**
   * Prices a bag for a Pakistan address and signs the result. Every line must
   * be buyable; otherwise it is refused (409) and says which lines are not. It
   * creates no customer, order, reservation or stored cart.
   */
  async quoteCheckout(dto: CheckoutQuoteDto): Promise<CheckoutQuoteResponse> {
    const { shippingAddress } = dto;
    if (!isDeliveryCountry(shippingAddress.country)) {
      throw new BusinessException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_DESTINATION',
        'We only deliver within Pakistan',
      );
    }

    const lines = canonicalBag(dto.items);
    const bag = await this.pricing.price(lines);

    const blocked = bag.lines.filter((line) => line.issue !== null);
    if (blocked.length > 0) {
      const code =
        (['PRODUCT_UNAVAILABLE', 'CURRENCY_MISMATCH'] as const).find((issue) =>
          blocked.some((line) => line.issue === issue),
        ) ?? 'INSUFFICIENT_STOCK';
      throw new BusinessException(
        HttpStatus.CONFLICT,
        code,
        'Some products in your bag cannot be bought as they are. Review your bag.',
        {
          issues: blocked.map((line) => ({
            productId: line.productId,
            issue: line.issue,
          })),
        },
      );
    }

    const quoted = bag.lines.map((line) => ({
      number: line.number,
      quantity: line.quantity,
      // Every line is for sale: the ones that were not are refused above.
      unitPrice: line.unitPrice as NonNullable<typeof line.unitPrice>,
    }));
    const price = priceOrder(quoted, DEMO_CHARGES);
    if (
      exceedsMaxOrderAmount(price.subtotal) ||
      exceedsMaxOrderAmount(price.total)
    ) {
      throw this.tooLarge();
    }

    const { token, expiresAt } = this.tokens.issue(
      buildQuoteClaims(
        bag.currency,
        quoted,
        price,
        DEMO_CHARGES,
        shippingAddress,
      ),
    );
    return {
      currency: bag.currency,
      paymentMethod: 'COD',
      items: bag.lines.map(toLineResponse),
      subtotal: toAmount(price.subtotal),
      shipping: toAmount(DEMO_CHARGES.shipping),
      tax: toAmount(DEMO_CHARGES.tax),
      discount: toAmount(DEMO_CHARGES.discount),
      total: toAmount(price.total),
      quoteToken: token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private invalidBag(error: unknown): unknown {
    if (error instanceof BagRuleError) {
      return new BusinessException(
        HttpStatus.BAD_REQUEST,
        'INVALID_BAG',
        error.message,
      );
    }
    return error;
  }

  private tooLarge(): BusinessException {
    return new BusinessException(
      HttpStatus.BAD_REQUEST,
      'ORDER_TOO_LARGE',
      'This bag is worth more than a single order can be. Remove something.',
    );
  }
}
