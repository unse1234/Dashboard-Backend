import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  createStorefrontToken,
  issueStorefrontToken,
} from '../storefront-tokens/storefront-tokens';
import type { EmailJobPreparation } from './email-outbox.policy';
import { EmailOutboxStore, type ClaimedEmailJob } from './email-outbox.store';

/**
 * One job per email: the first confirmation email, then each resend. Recording
 * the same one twice is a no-op.
 */
export const orderConfirmationEmailKey = (orderId: string, resend = 0) =>
  resend === 0
    ? `order-confirmation:${orderId}`
    : `order-confirmation:${orderId}:resend-${resend}`;

/**
 * The confirmation email of an order awaiting it: recorded with the order, and
 * written from the order's saved snapshots when it is sent.
 *
 * The link token is created once, when the email is recorded: its hash goes
 * into StorefrontToken and the token itself, sealed, into the job. Every
 * attempt therefore sends the same message with the same link, which is what
 * lets the provider's idempotency key and the recipient's inbox treat retries
 * as one email. The sealed token is erased when the job stops being pending.
 */
@Injectable()
export class OrderConfirmationEmails {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: EmailOutboxStore,
    private readonly mail: MailService,
  ) {}

  /**
   * Records the confirmation email of an order awaiting confirmation, with its
   * link token. Use the order's own transaction, so the order, its email and
   * its token are written together or not at all; given the shared client it
   * opens a transaction of its own. Send it once the transaction has committed
   * (`EmailOutboxDispatcher.dispatchAfterCommit`); the scheduled run sends it
   * otherwise.
   *
   * `resend` numbers a repeat of the email (1, 2, ...). The caller makes the
   * earlier links and queued emails stale first; the deadline is the order's,
   * so a resend never extends the reservation.
   */
  async enqueue(
    db: Db,
    orderId: string,
    options: { resend?: number } = {},
  ): Promise<{ jobId: string; created: boolean }> {
    if (db instanceof PrismaService) {
      return db.$transaction((tx) => this.enqueue(tx, orderId, options));
    }

    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        confirmationStatus: true,
        confirmationEmail: true,
        confirmationExpiresAt: true,
      },
    });
    if (
      !order ||
      order.confirmationStatus !== 'AWAITING_CONFIRMATION' ||
      !order.confirmationEmail ||
      !order.confirmationExpiresAt ||
      order.confirmationExpiresAt.getTime() <= Date.now()
    ) {
      throw new Error(
        'Only an order still awaiting confirmation gets a confirmation email',
      );
    }

    const token = createStorefrontToken('ORDER_CONFIRMATION');
    const job = await this.store.enqueue(db, {
      type: 'ORDER_CONFIRMATION',
      recipient: order.confirmationEmail,
      orderId,
      idempotencyKey: orderConfirmationEmailKey(orderId, options.resend),
      secrets: { token },
    });
    // A repeat finds the job already recorded, with its own token.
    if (job.created) {
      await issueStorefrontToken(db, {
        purpose: 'ORDER_CONFIRMATION',
        orderId,
        email: order.confirmationEmail,
        expiresAt: order.confirmationExpiresAt,
        token,
      });
    }
    return { jobId: job.id, created: job.created };
  }

  /** What to do with a claimed job: send this message, or stop. */
  async prepare(job: ClaimedEmailJob): Promise<EmailJobPreparation> {
    if (!job.orderId) {
      return {
        action: 'fail',
        code: 'ORDER_MISSING',
        message: 'The job names no order',
      };
    }
    const order = await this.prisma.order.findUnique({
      where: { id: job.orderId },
      select: {
        number: true,
        customerName: true,
        currency: true,
        paymentMethod: true,
        subtotal: true,
        shipping: true,
        tax: true,
        discount: true,
        total: true,
        shippingAddress: true,
        confirmationStatus: true,
        confirmationEmail: true,
        confirmationExpiresAt: true,
        items: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            productName: true,
            quantity: true,
            unitPrice: true,
            total: true,
          },
        },
      },
    });
    if (!order) return { action: 'cancel', code: 'ORDER_NOT_FOUND' };
    if (order.confirmationStatus !== 'AWAITING_CONFIRMATION') {
      return { action: 'cancel', code: 'ORDER_NOT_AWAITING' };
    }
    const expiresAt = order.confirmationExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      return { action: 'cancel', code: 'DEADLINE_PASSED' };
    }
    if (order.confirmationEmail !== job.recipient) {
      return {
        action: 'fail',
        code: 'RECIPIENT_MISMATCH',
        message: "The job's recipient is not the order's confirmation address",
      };
    }
    const token = job.secrets?.token;
    if (!token) {
      return {
        action: 'fail',
        code: 'PAYLOAD_UNREADABLE',
        message: 'The link token could not be read',
      };
    }

    const message = this.mail.orderConfirmation(
      job.recipient,
      {
        orderNumber: order.number,
        customerName: order.customerName,
        currency: order.currency,
        paymentMethod: order.paymentMethod,
        items: order.items,
        subtotal: order.subtotal,
        shipping: order.shipping,
        tax: order.tax,
        discount: order.discount,
        total: order.total,
        shippingAddress: order.shippingAddress,
        expiresAt,
      },
      token,
    );
    return { action: 'send', message, retryUntil: expiresAt };
  }
}
