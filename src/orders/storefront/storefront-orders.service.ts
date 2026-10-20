import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business-error';
import { sha256 } from '../../common/crypto.util';
import { formatPublicId } from '../../common/public-id';
import { resolveGuestCustomer } from '../../customers/guest-customer';
import { EmailOutboxDispatcher } from '../../email-outbox/email-outbox.dispatcher';
import { OrderConfirmationEmails } from '../../email-outbox/order-confirmation-emails';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import { issueStorefrontToken } from '../../storefront-tokens/storefront-tokens';
import {
  PlacementError,
  placeOrder,
  type PlacementFailure,
} from '../order-placement';
import { orderDetailSelect, type OrderDetailRow } from '../order.mapper';
import { LAZY_EXPIRY_LIMIT, OrderExpiryService } from '../order-expiry.service';
import {
  CHECKOUT_RECEIPT_GRACE_MS,
  MAX_AWAITING_ORDERS_PER_EMAIL,
  OrderConfirmationSettings,
} from './order-confirmation.settings';
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
  toConfirmationRequired,
  toStorefrontReceipt,
  type StorefrontPlacement,
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
    private readonly confirmationSettings: OrderConfirmationSettings,
    private readonly confirmationEmails: OrderConfirmationEmails,
    private readonly outbox: EmailOutboxDispatcher,
    private readonly expiry: OrderExpiryService,
  ) {}

  /**
   * One address may have only so many orders waiting for confirmation, so
   * nobody can hold the shop's stock with unconfirmed orders. Counted in the
   * database (the rate limiter forgets on restart), and serialised per address
   * so two orders at once cannot both slip under the limit.
   */
  private async limitAwaitingOrders(tx: Db, email: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`awaiting-email:${email}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS "count" FROM "Order"
      WHERE "confirmationStatus" = 'AWAITING_CONFIRMATION'
        AND "confirmationEmail" = ${email}
        AND "confirmationExpiresAt" > (now() AT TIME ZONE 'UTC')`;
    if (count >= MAX_AWAITING_ORDERS_PER_EMAIL) {
      throw new BusinessException(
        HttpStatus.TOO_MANY_REQUESTS,
        'TOO_MANY_PENDING_ORDERS',
        'You already have orders waiting for confirmation. Confirm them from your email, or wait for them to expire, before placing another.',
      );
    }
  }

  /**
   * One transaction: customer found or created, stock taken, order and lines
   * written. If anything refuses, none of it happened.
   *
   * With email confirmation on, the same transaction marks the order as
   * awaiting confirmation (its stock is then reserved, not sold) and records
   * its confirmation email, the email's link token and the guest's receipt
   * token. The email is sent only after the commit, never inside it.
   *
   * `key` makes a retry safe. The same key with the same request returns the
   * order already placed, even after the quote has expired or prices and stock
   * have moved on; the same key with a different request is refused. Requests
   * that share a key are serialised by an advisory lock, so two of them racing
   * cannot both place an order, reserve stock twice or record two emails.
   */
  async place(key: string, dto: PlaceOrderDto): Promise<StorefrontPlacement> {
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

    // Stock held by orders nobody confirmed in time goes back before this
    // order looks for it, in transactions of their own.
    await this.expiry.expireOverdue({
      productNumbers: lines.map((line) => line.number),
      limit: LAZY_EXPIRY_LIMIT,
    });

    const placed = await this.prisma.$transaction(
      async (
        tx,
      ): Promise<{
        answer: StorefrontPlacement;
        emailJobId: string | null;
      }> => {
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
          // Answered as what it is, whatever the switch says now: an order
          // placed before confirmation was turned on is a receipt, one waiting
          // for its buyer stays that, with a receipt token of its own.
          return { answer: await this.answer(tx, existing), emailJobId: null };
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

        // Bookkeeping, as for every guest order. A storefront account with the
        // same address gets nothing: the order is not proven to be theirs.
        const customer = await resolveGuestCustomer(tx, contact);

        const confirmation = this.confirmationSettings.enabled
          ? {
              email: contact.email,
              expiresAt: new Date(Date.now() + this.confirmationSettings.ttlMs),
            }
          : undefined;
        if (confirmation) await this.limitAwaitingOrders(tx, contact.email);

        let order: OrderDetailRow;
        try {
          order = await placeOrder(tx, {
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
            confirmation,
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
        } catch (error) {
          throw error instanceof PlacementError
            ? guestException(error.failure)
            : error;
        }

        if (!confirmation) {
          return { answer: toStorefrontReceipt(order), emailJobId: null };
        }
        // With the order, or not at all: if recording the email fails, the
        // order and its reservation roll back with it.
        const { jobId } = await this.confirmationEmails.enqueue(tx, order.id);
        return { answer: await this.answer(tx, order), emailJobId: jobId };
      },
    );

    // After the commit, never inside it. If this attempt fails or the process
    // stops, the job is still pending and the scheduled run sends it.
    if (placed.emailJobId) this.outbox.dispatchAfterCommit(placed.emailJobId);
    return placed.answer;
  }

  /** The answer for an order this key placed, now or by an earlier request. */
  private async answer(
    tx: Db,
    order: OrderDetailRow,
  ): Promise<StorefrontPlacement> {
    if (order.confirmationStatus === 'EXEMPT')
      return toStorefrontReceipt(order);
    return toConfirmationRequired(order, await this.issueReceipt(tx, order));
  }

  /**
   * A receipt token for the guest who placed this order. Only its hash is kept,
   * so a retry cannot be handed the token the lost response carried: it gets a
   * new one, and both keep working. It lasts until a day after the deadline,
   * long enough to learn how the order ended; after that there is none.
   */
  private async issueReceipt(
    tx: Db,
    order: OrderDetailRow,
  ): Promise<string | null> {
    if (!order.confirmationEmail || !order.confirmationExpiresAt) return null;
    const expiresAt = new Date(
      order.confirmationExpiresAt.getTime() + CHECKOUT_RECEIPT_GRACE_MS,
    );
    if (expiresAt.getTime() <= Date.now()) return null;
    const { token } = await issueStorefrontToken(tx, {
      purpose: 'CHECKOUT_RECEIPT',
      orderId: order.id,
      email: order.confirmationEmail,
      expiresAt,
    });
    return token;
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
