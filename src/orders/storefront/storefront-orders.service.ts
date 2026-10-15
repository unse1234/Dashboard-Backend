import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business-error';
import { sha256 } from '../../common/crypto.util';
import { formatPublicId } from '../../common/public-id';
import { resolveGuestCustomer } from '../../customers/guest-customer';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PlacementError,
  placeOrder,
  type PlacementFailure,
} from '../order-placement';
import { orderDetailSelect } from '../order.mapper';
import { canonicalBag } from './bag-input';
import { DEMO_CHARGES } from './quote-claims';
import {
  pricedMismatch,
  requestMismatch,
  type QuoteMismatch,
} from './quote-agreement';
import { QuoteTokenService } from './quote-token.service';
import {
  DELIVERY_COUNTRY,
  isDeliveryCountry,
} from './dto/storefront-address.dto';
import type { PlaceOrderDto } from './dto/place-order.dto';
import {
  toStorefrontReceipt,
  type StorefrontReceipt,
} from './storefront-order.mapper';

/**
 * A guest's keys live under this prefix. Dashboard keys are 8 to 100 letters,
 * digits, "-" or "_", so they can never contain ":" and the two namespaces
 * cannot collide, whatever either side sends.
 */
export const GUEST_KEY_PREFIX = 'sf:';

const QUOTE_CHANGED_MESSAGE =
  'Something changed since you reviewed your order. Review it again before placing it.';

/**
 * A request's identity: the same bag, buyer, address and quote are the same
 * request however the lines are ordered, so a retry that lists them differently
 * is still a retry. The quote token is part of it: a guest who renews the quote
 * has made a different request, and may not reuse the old key for it.
 */
export function guestRequestHash(request: {
  contact: { name: string; email: string; phone: string };
  lines: readonly { number: number; quantity: number }[];
  shippingAddress: Prisma.InputJsonObject;
  quoteToken: string;
}): string {
  return sha256(
    JSON.stringify({
      v: 1,
      contact: request.contact,
      lines: [...request.lines]
        .sort((a, b) => a.number - b.number)
        .map(({ number, quantity }) => [number, quantity]),
      shippingAddress: request.shippingAddress,
      quoteToken: request.quoteToken,
    }),
  );
}

/** Places a guest's cash-on-delivery order. */
@Injectable()
export class StorefrontOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: QuoteTokenService,
  ) {}

  /**
   * One transaction: customer found or created, stock taken, order and lines
   * written. If anything refuses, none of it happened.
   *
   * `key` makes a retry safe. The same key with the same request returns the
   * order already placed, even after the quote has expired or prices and stock
   * have moved on; the same key with a different request is refused. Requests
   * that share a key are serialised by an advisory lock, so two of them racing
   * cannot both place an order.
   */
  async place(key: string, dto: PlaceOrderDto): Promise<StorefrontReceipt> {
    const { contact, shippingAddress } = dto;
    if (!isDeliveryCountry(shippingAddress.country)) {
      throw new BusinessException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_DESTINATION',
        'We only deliver within Pakistan',
      );
    }
    const lines = canonicalBag(dto.items);

    const snapshot: Prisma.InputJsonObject = {
      recipientName: shippingAddress.recipientName,
      phone: shippingAddress.phone ?? null,
      addressLine1: shippingAddress.addressLine1,
      addressLine2: shippingAddress.addressLine2 ?? null,
      city: shippingAddress.city,
      region: shippingAddress.region,
      postalCode: shippingAddress.postalCode ?? null,
      country: DELIVERY_COUNTRY,
    };
    const requestHash = guestRequestHash({
      contact: {
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
      },
      lines,
      shippingAddress: snapshot,
      quoteToken: dto.quoteToken,
    });
    const storedKey = `${GUEST_KEY_PREFIX}${key}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${storedKey}))`;

      // Before anything about the quote, the catalogue or the stock is looked
      // at: an order that was placed is answered with itself, always.
      const existing = await tx.order.findUnique({
        where: { idempotencyKey: storedKey },
        select: { ...orderDetailSelect, requestHash: true },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new BusinessException(
            HttpStatus.CONFLICT,
            'IDEMPOTENCY_CONFLICT',
            'This Idempotency-Key was already used for a different order',
          );
        }
        return toStorefrontReceipt(existing);
      }

      const verified = this.tokens.verify(dto.quoteToken);
      if (verified.status === 'invalid') {
        throw quoteChanged(
          'TOKEN_INVALID',
          'Your checkout could not be verified. Review your order and try again.',
        );
      }
      if (verified.status === 'expired') {
        throw quoteChanged(
          'QUOTE_EXPIRED',
          'Your price quote has expired. Review your order to get a new one.',
        );
      }
      const { claims } = verified;
      const changed = requestMismatch(claims, lines, shippingAddress.region);
      if (changed) throw quoteChanged(changed, QUOTE_CHANGED_MESSAGE);

      const customer = await resolveGuestCustomer(tx, contact);

      try {
        const order = await placeOrder(tx, {
          customer: {
            id: customer.id,
            // The order records what was submitted, whoever the customer is.
            name: contact.name,
            email: contact.email,
            phone: contact.phone,
          },
          lines,
          adjustments: DEMO_CHARGES,
          paymentStatus: 'PENDING',
          paymentMethod: 'COD',
          // The currency the guest was quoted in, not whatever it is now.
          requiredCurrency: claims.currency,
          shippingAddress: snapshot,
          // The delivery address is the billing address in V1.
          billingAddress: snapshot,
          actorId: null,
          key: storedKey,
          requestHash,
          review: (priced) => {
            // The catalogue can change between quote and placement. What counts
            // is what the stock statement read.
            for (const line of priced.lines) {
              if (
                line.currency !== claims.currency ||
                !line.unitPrice.greaterThan(0)
              ) {
                throw unavailable(line.number);
              }
            }
            const mismatch = pricedMismatch(claims, priced);
            if (mismatch) throw quoteChanged(mismatch, QUOTE_CHANGED_MESSAGE);
          },
        });
        return toStorefrontReceipt(order);
      } catch (error) {
        throw error instanceof PlacementError
          ? guestException(error.failure)
          : error;
      }
    });
  }
}

function quoteChanged(
  reason: QuoteMismatch | 'TOKEN_INVALID' | 'QUOTE_EXPIRED',
  message: string,
): BusinessException {
  return new BusinessException(HttpStatus.CONFLICT, 'QUOTE_CHANGED', message, {
    reason,
  });
}

function unavailable(productNumber: number | null): BusinessException {
  return new BusinessException(
    HttpStatus.CONFLICT,
    'PRODUCT_UNAVAILABLE',
    'A product in your bag is no longer available. Review your bag.',
    productNumber === null
      ? {}
      : { productId: formatPublicId('PRD', productNumber) },
  );
}

/**
 * The storefront's wording of a placement failure. Unlike the dashboard's it
 * never names a SKU or says how many are left.
 */
function guestException(failure: PlacementFailure): BusinessException {
  switch (failure.kind) {
    case 'PRODUCT_UNAVAILABLE':
      return unavailable(failure.productNumber);
    case 'INSUFFICIENT_STOCK':
      return new BusinessException(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_STOCK',
        'There is not enough stock for this quantity. Review your bag.',
        { productId: formatPublicId('PRD', failure.productNumber) },
      );
    case 'TOO_LARGE':
      return new BusinessException(
        HttpStatus.BAD_REQUEST,
        'ORDER_TOO_LARGE',
        'This bag is worth more than a single order can be. Remove something.',
      );
    // Both need a product to change currency between the quote and the order,
    // or a charge the demo does not have: the quote is no longer true.
    case 'MIXED_CURRENCY':
      return unavailable(null);
    case 'DISCOUNT_TOO_LARGE':
      return quoteChanged('TOTAL_CHANGED', QUOTE_CHANGED_MESSAGE);
  }
}
