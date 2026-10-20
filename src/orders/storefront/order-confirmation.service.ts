import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business-error';
import { EmailOutboxDispatcher } from '../../email-outbox/email-outbox.dispatcher';
import { EmailOutboxStore } from '../../email-outbox/email-outbox.store';
import { OrderConfirmationEmails } from '../../email-outbox/order-confirmation-emails';
import {
  Prisma,
  type OrderConfirmationStatus,
} from '../../generated/prisma/client';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import {
  checkStorefrontToken,
  consumeStorefrontToken,
  issueStorefrontToken,
  voidStorefrontTokens,
} from '../../storefront-tokens/storefront-tokens';
import { OrderExpiryService } from '../order-expiry.service';
import { orderDetailSelect } from '../order.mapper';
import {
  CONFIRMATION_RESEND_COOLDOWN_MS,
  MAX_CONFIRMATION_RESENDS,
  OrderConfirmationSettings,
} from './order-confirmation.settings';
import {
  confirmationStateOf,
  toConfirmationPreview,
  toConfirmationResult,
  type AccountOffer,
  type CheckoutReceiptStatus,
  type ConfirmationState,
  type StorefrontConfirmationPreview,
  type StorefrontConfirmationResult,
} from './storefront-order.mapper';

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);
const COOLDOWN = Prisma.raw(
  `interval '${CONFIRMATION_RESEND_COOLDOWN_MS} milliseconds'`,
);

interface LockedOrder {
  id: string;
  confirmationStatus: OrderConfirmationStatus;
  confirmationEmail: string | null;
  /** Before its deadline, by the database's clock. */
  live: boolean;
}

type ConfirmOutcome =
  | { kind: 'confirmed'; account: AccountOffer }
  | { kind: 'already' | 'expired' | 'replaced' | 'not-found' };

type ResendOutcome =
  | { kind: 'queued'; jobId: string }
  | { kind: 'not-pending'; status: ConfirmationState }
  | { kind: 'limit' }
  | { kind: 'too-soon'; waitSeconds: number };

const confirmationNotFound = () =>
  new BusinessException(
    HttpStatus.NOT_FOUND,
    'CONFIRMATION_NOT_FOUND',
    'This confirmation link is not valid. Use the link in the email we sent you.',
  );

const receiptNotFound = () =>
  new BusinessException(
    HttpStatus.NOT_FOUND,
    'RECEIPT_NOT_FOUND',
    'This checkout could not be found. It may be too old to look up.',
  );

/**
 * The life of an order awaiting its buyer: what its link shows, confirming
 * it, and what the guest's checkout receipt allows (its status, and asking
 * for the email again).
 *
 * Every credential does one thing. A confirmation token ("oc_") previews and
 * confirms its own order; a receipt token ("cr_") reads its order's status and
 * asks for a new email. Neither is ever taken from a URL, and nothing here is
 * reached by an order number or an email address.
 */
@Injectable()
export class OrderConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrderConfirmationSettings,
    private readonly expiry: OrderExpiryService,
    private readonly outboxStore: EmailOutboxStore,
    private readonly outbox: EmailOutboxDispatcher,
    private readonly emails: OrderConfirmationEmails,
  ) {}

  /**
   * What a confirmation link is about, without using it: it writes nothing,
   * so opening the link (or a mail scanner opening it) changes nothing.
   */
  async preview(token: string): Promise<StorefrontConfirmationPreview> {
    const found = await checkStorefrontToken(
      this.prisma,
      token,
      'ORDER_CONFIRMATION',
    );
    if (found.status === 'invalid' || !found.record.orderId) {
      throw confirmationNotFound();
    }
    const order = await this.prisma.order.findUnique({
      where: { id: found.record.orderId },
      select: orderDetailSelect,
    });
    if (!order || order.confirmationStatus === 'EXEMPT') {
      throw confirmationNotFound();
    }
    return toConfirmationPreview(order, found.status === 'used');
  }

  /**
   * Confirms the order a link belongs to. One transaction, holding the order's
   * row: its state and deadline are read under the lock (deadline by the
   * database's clock), the token is used, and the order becomes CONFIRMED by a
   * compare-and-set. Its stock was taken when it was placed and stays taken;
   * nothing about stock happens here. The order's other links stop working and
   * its queued confirmation emails are cancelled.
   *
   * Pressing it again (or two tabs at once) is safe: once confirmed, the answer
   * is the same order with `alreadyConfirmed: true`, and nothing is issued
   * again, setup permission included. Past the deadline, the order is expired
   * there and then if nothing else has, and the answer is 410.
   */
  async confirm(token: string): Promise<StorefrontConfirmationResult> {
    const found = await checkStorefrontToken(
      this.prisma,
      token,
      'ORDER_CONFIRMATION',
    );
    if (found.status === 'invalid') throw confirmationNotFound();
    const orderId = found.record.orderId;
    if (!orderId) throw confirmationNotFound();

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<ConfirmOutcome> => {
        const order = await this.lockOrder(tx, orderId);
        if (!order || order.confirmationStatus === 'EXEMPT') {
          return { kind: 'not-found' };
        }
        if (order.confirmationStatus === 'CONFIRMED')
          return { kind: 'already' };
        if (order.confirmationStatus !== 'AWAITING_CONFIRMATION') {
          return { kind: 'expired' };
        }
        if (!order.live) {
          // Committed even though the answer is an error: the stock goes back.
          await this.expiry.expireIfOverdue(tx, order.id);
          return { kind: 'expired' };
        }

        const used = await consumeStorefrontToken(
          tx,
          token,
          'ORDER_CONFIRMATION',
        );
        if (used.status === 'used') return { kind: 'replaced' };
        if (used.status === 'expired') return { kind: 'expired' };
        if (used.status === 'invalid') return { kind: 'not-found' };

        const email = order.confirmationEmail!;
        // The inbox is proven now, so an account with this address may have it.
        const account = await tx.storefrontAccount.findUnique({
          where: { email },
          select: { id: true },
        });
        const confirmed = await tx.$executeRaw`
          UPDATE "Order"
          SET "confirmationStatus" = 'CONFIRMED',
              "confirmedAt" = ${NOW_UTC},
              "storefrontAccountId" = ${account?.id ?? null},
              "updatedAt" = ${NOW_UTC}
          WHERE "id" = ${order.id}
            AND "confirmationStatus" = 'AWAITING_CONFIRMATION'
            AND "confirmationExpiresAt" > ${NOW_UTC}`;
        if (confirmed !== 1) {
          throw new Error('The order changed while its row was locked');
        }
        await voidStorefrontTokens(tx, {
          purpose: 'ORDER_CONFIRMATION',
          orderId: order.id,
        });
        await this.outboxStore.cancelForOrder(tx, order.id, 'ORDER_CONFIRMED');

        return {
          kind: 'confirmed',
          account: await this.offerAccount(tx, order.id, email, !!account),
        };
      },
    );

    switch (outcome.kind) {
      case 'not-found':
        throw confirmationNotFound();
      case 'expired':
        throw new BusinessException(
          HttpStatus.GONE,
          'CONFIRMATION_EXPIRED',
          'This order was not confirmed in time and has been cancelled. Place it again if you still want it.',
        );
      case 'replaced':
        throw new BusinessException(
          HttpStatus.GONE,
          'CONFIRMATION_LINK_REPLACED',
          'A newer confirmation email was sent for this order. Use the link in the latest email.',
        );
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: orderDetailSelect,
    });
    return toConfirmationResult(
      order,
      outcome.kind === 'already',
      outcome.kind === 'confirmed' ? outcome.account : { kind: 'NONE' },
    );
  }

  /** How the guest's order stands, for the page that waits for confirmation. */
  async receiptStatus(receiptToken: string): Promise<CheckoutReceiptStatus> {
    const orderId = await this.receiptOrderId(receiptToken);
    return this.statusOf(orderId);
  }

  /**
   * Sends the confirmation email again, with a new link. The earlier links stop
   * working and their queued emails are cancelled, so only the newest email is
   * any use. The deadline does not move: a resend never extends how long the
   * stock is held. At most MAX_CONFIRMATION_RESENDS per order, one per
   * CONFIRMATION_RESEND_COOLDOWN_MS, counted in the database.
   */
  async resend(receiptToken: string): Promise<CheckoutReceiptStatus> {
    const orderId = await this.receiptOrderId(receiptToken);

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<ResendOutcome> => {
        const order = await this.lockOrder(tx, orderId);
        if (!order || order.confirmationStatus === 'EXEMPT') {
          throw receiptNotFound();
        }
        if (order.confirmationStatus !== 'AWAITING_CONFIRMATION') {
          return { kind: 'not-pending', status: order.confirmationStatus };
        }
        if (!order.live) {
          await this.expiry.expireIfOverdue(tx, order.id);
          return { kind: 'not-pending', status: 'EXPIRED' };
        }

        const [sent] = await tx.$queryRaw<
          { count: number; waitSeconds: number | null }[]
        >`
          SELECT count(*)::int AS "count",
                 CEIL(EXTRACT(EPOCH FROM (max("createdAt") + ${COOLDOWN} - ${NOW_UTC})))::int
                   AS "waitSeconds"
          FROM "EmailJob"
          WHERE "orderId" = ${order.id} AND "type" = 'ORDER_CONFIRMATION'`;
        const resends = Math.max(sent.count - 1, 0);
        if (resends >= MAX_CONFIRMATION_RESENDS) return { kind: 'limit' };
        if (sent.waitSeconds !== null && sent.waitSeconds > 0) {
          return { kind: 'too-soon', waitSeconds: sent.waitSeconds };
        }

        // Rotation: earlier links and the emails still queued with them are
        // stale from here on.
        await voidStorefrontTokens(tx, {
          purpose: 'ORDER_CONFIRMATION',
          orderId: order.id,
        });
        await this.outboxStore.cancelForOrder(tx, order.id, 'SUPERSEDED');
        const { jobId } = await this.emails.enqueue(tx, order.id, {
          resend: resends + 1,
        });
        return { kind: 'queued', jobId };
      },
    );

    switch (outcome.kind) {
      case 'not-pending':
        throw new BusinessException(
          HttpStatus.CONFLICT,
          'CONFIRMATION_NOT_PENDING',
          outcome.status === 'CONFIRMED'
            ? 'This order is already confirmed.'
            : 'This order was not confirmed in time and has been cancelled.',
          { status: outcome.status },
        );
      case 'limit':
        throw new BusinessException(
          HttpStatus.TOO_MANY_REQUESTS,
          'RESEND_LIMIT_REACHED',
          'The confirmation email cannot be sent again for this order. Look for it in your inbox, including spam.',
        );
      case 'too-soon':
        throw new BusinessException(
          HttpStatus.TOO_MANY_REQUESTS,
          'RESEND_TOO_SOON',
          'The confirmation email was sent a moment ago. Wait a little before asking again.',
          { retryAfterSeconds: outcome.waitSeconds },
        );
    }

    this.outbox.dispatchAfterCommit(outcome.jobId);
    return this.statusOf(orderId);
  }

  /** The order a live receipt token belongs to; 404 for anything else. */
  private async receiptOrderId(receiptToken: string): Promise<string> {
    const found = await checkStorefrontToken(
      this.prisma,
      receiptToken,
      'CHECKOUT_RECEIPT',
    );
    if (found.status !== 'valid' || !found.record.orderId) {
      throw receiptNotFound();
    }
    return found.record.orderId;
  }

  private async statusOf(orderId: string): Promise<CheckoutReceiptStatus> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        confirmationStatus: true,
        confirmationEmail: true,
        confirmationExpiresAt: true,
      },
    });
    const status = order ? confirmationStateOf(order) : null;
    if (!order || !status) throw receiptNotFound();

    let resend: CheckoutReceiptStatus['resend'] = {
      remaining: 0,
      availableAt: null,
    };
    if (status === 'AWAITING_CONFIRMATION') {
      const [sent] = await this.prisma.$queryRaw<
        { count: number; last: Date | null }[]
      >`
        SELECT count(*)::int AS "count", max("createdAt") AS "last"
        FROM "EmailJob"
        WHERE "orderId" = ${orderId} AND "type" = 'ORDER_CONFIRMATION'`;
      const remaining = Math.max(
        MAX_CONFIRMATION_RESENDS - Math.max(sent.count - 1, 0),
        0,
      );
      const next = sent.last
        ? new Date(sent.last.getTime() + CONFIRMATION_RESEND_COOLDOWN_MS)
        : new Date();
      resend = {
        remaining,
        availableAt:
          remaining > 0 && next < order.confirmationExpiresAt!
            ? next.toISOString()
            : null,
      };
    }

    return {
      status,
      expiresAt: order.confirmationExpiresAt!.toISOString(),
      email: order.confirmationEmail!,
      resend,
    };
  }

  private async lockOrder(
    tx: Db,
    orderId: string,
  ): Promise<LockedOrder | undefined> {
    const [order] = await tx.$queryRaw<LockedOrder[]>`
      SELECT "id", "confirmationStatus", "confirmationEmail",
             ("confirmationExpiresAt" > ${NOW_UTC}) AS "live"
      FROM "Order"
      WHERE "id" = ${orderId}
      FOR UPDATE`;
    return order;
  }

  /**
   * Only on the confirmation that changed the order: an account to sign in
   * to, or a short-lived permission to create one for the proven address.
   */
  private async offerAccount(
    tx: Db,
    orderId: string,
    email: string,
    accountExists: boolean,
  ): Promise<AccountOffer> {
    if (!this.settings.accountsEnabled) return { kind: 'NONE' };
    if (accountExists) return { kind: 'SIGN_IN' };
    const grant = await issueStorefrontToken(tx, {
      purpose: 'ACCOUNT_SETUP',
      orderId,
      email,
      expiresAt: new Date(Date.now() + this.settings.accountSetupTtlMs),
    });
    return {
      kind: 'SETUP_AVAILABLE',
      setupToken: grant.token,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }
}
