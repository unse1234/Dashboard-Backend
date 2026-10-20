import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type EmailJobType,
  type StorefrontTokenPurpose,
} from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  checkStorefrontToken,
  createStorefrontToken,
  issueStorefrontToken,
} from '../storefront-tokens/storefront-tokens';
import {
  ACCOUNT_EMAIL_COOLDOWN_MS,
  MAX_ACCOUNT_EMAILS_PER_DAY,
} from '../storefront-accounts/storefront-account.settings';
import type { EmailJobPreparation } from './email-outbox.policy';
import { EmailOutboxStore, type ClaimedEmailJob } from './email-outbox.store';

export type StorefrontAccountEmailType = Extract<
  EmailJobType,
  'ACCOUNT_SETUP_LINK' | 'STOREFRONT_PASSWORD_RESET'
>;

/** The token each kind of email carries. */
const TOKEN_PURPOSE: Record<
  StorefrontAccountEmailType,
  StorefrontTokenPurpose
> = {
  ACCOUNT_SETUP_LINK: 'ACCOUNT_SETUP',
  STOREFRONT_PASSWORD_RESET: 'PASSWORD_RESET',
};

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);
// Code constants, never request data, so they may be written into the SQL.
const COOLDOWN = Prisma.raw(
  `interval '${ACCOUNT_EMAIL_COOLDOWN_MS} milliseconds'`,
);

/**
 * The storefront account emails: a new setup link, and a password reset link.
 * Like the confirmation email, each is recorded in the transaction that issues
 * its token, with the token sealed in the job, and sent after commit.
 *
 * When the job is sent, the token is looked up again: a link already used,
 * replaced or expired, or a setup link for an address that has meanwhile got
 * an account, is not sent at all.
 */
@Injectable()
export class StorefrontAccountEmails {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: EmailOutboxStore,
    private readonly mail: MailService,
  ) {}

  /**
   * Serialises the account emails of one address for the rest of the
   * transaction, so that two requests at once cannot both pass `mayEmail`.
   */
  async lockAddress(tx: Db, email: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-email:${email}`}))`;
  }

  /**
   * Whether another email of this kind may go to this address now: not within
   * the cooldown of the last one, and not beyond the daily limit. Counted in
   * the database, so the limits hold across restarts and instances.
   */
  async mayEmail(
    db: Db,
    type: StorefrontAccountEmailType,
    recipient: string,
  ): Promise<boolean> {
    const [row] = await db.$queryRaw<{ today: number; recent: number }[]>`
      SELECT count(*)::int AS "today",
             (count(*) FILTER (WHERE "createdAt" > ${NOW_UTC} - ${COOLDOWN}))::int AS "recent"
      FROM "EmailJob"
      WHERE "recipient" = ${recipient}
        AND "type" = ${type}::"EmailJobType"
        AND "createdAt" > ${NOW_UTC} - interval '24 hours'`;
    return row.recent === 0 && row.today < MAX_ACCOUNT_EMAILS_PER_DAY;
  }

  /**
   * Records an email with a new account setup link for `email`, bound to one
   * of its confirmed orders. Run it in the transaction that decided the
   * address may have one.
   */
  async enqueueSetupLink(
    tx: Db,
    input: { email: string; orderId: string; expiresAt: Date },
  ): Promise<{ jobId: string }> {
    const token = createStorefrontToken('ACCOUNT_SETUP');
    const job = await this.store.enqueue(tx, {
      type: 'ACCOUNT_SETUP_LINK',
      recipient: input.email,
      // Not tied to the order: an order's confirmation or expiry cancels the
      // order's emails, and this one is about the address.
      orderId: null,
      idempotencyKey: `account-setup-link:${randomUUID()}`,
      secrets: { token },
    });
    await issueStorefrontToken(tx, {
      purpose: 'ACCOUNT_SETUP',
      orderId: input.orderId,
      email: input.email,
      expiresAt: input.expiresAt,
      token,
    });
    return { jobId: job.id };
  }

  /** Records an email with a password reset link for an account. */
  async enqueuePasswordReset(
    tx: Db,
    input: { accountId: string; email: string; expiresAt: Date },
  ): Promise<{ jobId: string }> {
    const token = createStorefrontToken('PASSWORD_RESET');
    const job = await this.store.enqueue(tx, {
      type: 'STOREFRONT_PASSWORD_RESET',
      recipient: input.email,
      orderId: null,
      idempotencyKey: `storefront-password-reset:${randomUUID()}`,
      secrets: { token },
    });
    await issueStorefrontToken(tx, {
      purpose: 'PASSWORD_RESET',
      accountId: input.accountId,
      email: input.email,
      expiresAt: input.expiresAt,
      token,
    });
    return { jobId: job.id };
  }

  /** What to do with a claimed job: send this message, or stop. */
  async prepare(
    job: ClaimedEmailJob & { type: StorefrontAccountEmailType },
  ): Promise<EmailJobPreparation> {
    const token = job.secrets?.token;
    if (!token) {
      return {
        action: 'fail',
        code: 'PAYLOAD_UNREADABLE',
        message: 'The link token could not be read',
      };
    }
    const found = await checkStorefrontToken(
      this.prisma,
      token,
      TOKEN_PURPOSE[job.type],
    );
    if (found.status === 'invalid') {
      return {
        action: 'fail',
        code: 'TOKEN_MISSING',
        message: "The job's link token is not on record",
      };
    }
    if (found.record.email !== job.recipient) {
      return {
        action: 'fail',
        code: 'RECIPIENT_MISMATCH',
        message: "The job's recipient is not the token's address",
      };
    }
    if (found.status === 'used')
      return { action: 'cancel', code: 'TOKEN_USED' };
    if (found.status === 'expired') {
      return { action: 'cancel', code: 'TOKEN_EXPIRED' };
    }
    const { expiresAt } = found.record;

    if (job.type === 'ACCOUNT_SETUP_LINK') {
      const account = await this.prisma.storefrontAccount.findUnique({
        where: { email: job.recipient },
        select: { id: true },
      });
      if (account) return { action: 'cancel', code: 'ACCOUNT_EXISTS' };
      return {
        action: 'send',
        message: this.mail.accountSetupLink(job.recipient, token, expiresAt),
        retryUntil: expiresAt,
      };
    }

    const account = found.record.accountId
      ? await this.prisma.storefrontAccount.findUnique({
          where: { id: found.record.accountId },
          select: { email: true },
        })
      : null;
    if (account?.email !== job.recipient) {
      return { action: 'cancel', code: 'ACCOUNT_NOT_FOUND' };
    }
    return {
      action: 'send',
      message: this.mail.storefrontPasswordReset(
        job.recipient,
        token,
        expiresAt,
      ),
      retryUntil: expiresAt,
    };
  }
}
