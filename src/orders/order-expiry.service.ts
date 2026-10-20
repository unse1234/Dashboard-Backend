import { Injectable } from '@nestjs/common';
import { EmailOutboxStore } from '../email-outbox/email-outbox.store';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { voidStorefrontTokens } from '../storefront-tokens/storefront-tokens';
import { returnOrderStock } from './order-stock';

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);

/** Orders one sweep expires at most; the next run continues. */
export const EXPIRY_SWEEP_LIMIT = 200;

/** Overdue orders one checkout releases at most before it looks for stock. */
export const LAZY_EXPIRY_LIMIT = 20;

/**
 * Ends orders whose buyer did not confirm them in time: the order becomes
 * CANCELLED and EXPIRED in one statement, its stock goes back exactly as when
 * staff cancel an order, its confirmation links stop working and its queued
 * confirmation emails are cancelled.
 *
 * Exactly once, however many run at once: the change is a compare-and-set on
 * AWAITING_CONFIRMATION, and only the transaction that made it returns the
 * stock. A confirmation racing it either commits first (and the expiry finds
 * nothing to do) or waits for the row and finds the order expired.
 *
 * One order per transaction, so a transaction only ever locks one order and
 * that order's products in id order, like every other stock change.
 */
@Injectable()
export class OrderExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxStore,
  ) {}

  /**
   * Expires the order if it is still awaiting confirmation and its deadline
   * has passed (database clock), inside the caller's transaction. Returns
   * whether this call expired it.
   */
  async expireIfOverdue(db: Db, orderId: string): Promise<boolean> {
    const [expired] = await db.$queryRaw<{ number: number }[]>`
      UPDATE "Order"
      SET "status" = 'CANCELLED',
          "confirmationStatus" = 'EXPIRED',
          "updatedAt" = ${NOW_UTC}
      WHERE "id" = ${orderId}
        AND "confirmationStatus" = 'AWAITING_CONFIRMATION'
        AND "confirmationExpiresAt" <= ${NOW_UTC}
      RETURNING "number"`;
    if (!expired) return false;

    await returnOrderStock(db, orderId, expired.number);
    await db.orderEvent.create({
      data: {
        orderId,
        type: 'STATUS_CHANGED',
        fromStatus: 'PENDING',
        toStatus: 'CANCELLED',
        // An awaiting order is always unpaid (a CHECK says so), and stays so.
        fromPaymentStatus: 'PENDING',
        toPaymentStatus: 'PENDING',
        actorId: null,
      },
    });
    await voidStorefrontTokens(db, {
      purpose: 'ORDER_CONFIRMATION',
      orderId,
    });
    await this.outbox.cancelForOrder(db, orderId, 'ORDER_EXPIRED');
    return true;
  }

  /**
   * Expires overdue orders, oldest deadline first, each in a transaction of
   * its own. With `productNumbers`, only orders holding one of those products:
   * what a shopper about to buy them needs released first. Orders another
   * transaction holds are skipped, not waited for. Returns how many expired.
   */
  async expireOverdue(
    options: { limit?: number; productNumbers?: number[] } = {},
  ): Promise<number> {
    const limit = options.limit ?? EXPIRY_SWEEP_LIMIT;
    const products =
      options.productNumbers === undefined
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (
            SELECT 1 FROM "OrderItem" i
            JOIN "Product" p ON p."id" = i."catalogProductId"
            WHERE i."orderId" = o."id"
              AND p."number" = ANY(${options.productNumbers}::int[]))`;
    if (options.productNumbers?.length === 0) return 0;

    let expired = 0;
    for (let i = 0; i < limit; i++) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const [due] = await tx.$queryRaw<{ id: string }[]>`
          SELECT o."id" FROM "Order" o
          WHERE o."confirmationStatus" = 'AWAITING_CONFIRMATION'
            AND o."confirmationExpiresAt" <= ${NOW_UTC}
            ${products}
          ORDER BY o."confirmationExpiresAt", o."id"
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`;
        if (!due) return null;
        return this.expireIfOverdue(tx, due.id);
      });
      if (outcome === null) break;
      if (outcome) expired += 1;
    }
    return expired;
  }
}
