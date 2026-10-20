import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import { BusinessException } from '../common/business-error';
import { EmailOutboxDispatcher } from '../email-outbox/email-outbox.dispatcher';
import { StorefrontAccountEmails } from '../email-outbox/storefront-account-emails';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkStorefrontToken,
  consumeStorefrontToken,
  voidStorefrontTokens,
} from '../storefront-tokens/storefront-tokens';
import type {
  RequestSetupLinkDto,
  StorefrontResetPasswordDto,
} from './dto/storefront-account.dto';
import {
  SETUP_LINK_TTL_MS,
  STOREFRONT_PASSWORD_RESET_TTL_MS,
} from './storefront-account.settings';
import { passwordMismatch } from './storefront-accounts.service';
import { StorefrontSessionsService } from './storefront-sessions.service';

/** Said for every address, whether or not a link was sent. */
export const SETUP_LINK_REQUESTED =
  'If this email address can set up an account, we have sent it a link. If you already have an account, sign in or reset your password.';
export const PASSWORD_RESET_REQUESTED =
  'If an account exists for this email address, we have sent it a link to reset the password.';

const resetTokenInvalid = () =>
  new BusinessException(
    HttpStatus.BAD_REQUEST,
    'RESET_TOKEN_INVALID',
    'This password reset link is not valid or has expired. Ask for a new one.',
  );

/**
 * Getting back into a storefront account, and getting a new setup link.
 *
 * Both requests answer the same whatever the address (no account, no
 * confirmed order, too many emails lately): only the inbox learns anything.
 * Each email is recorded in the transaction that issues its single-use token,
 * and the per-address limits are counted in the database under a lock on the
 * address, so neither concurrent requests nor a restart lift them.
 */
@Injectable()
export class StorefrontAccountRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: StorefrontSessionsService,
    private readonly emails: StorefrontAccountEmails,
    private readonly outbox: EmailOutboxDispatcher,
  ) {}

  /**
   * Emails a new setup link to an address that has a confirmed order and no
   * account, for example when the permission given at confirmation ran out.
   * The address is the one typed in, or the one an earlier setup token (used
   * or not, expired or not) was issued for; either way the link goes only to
   * that inbox, which proves it again.
   */
  async requestSetupLink(dto: RequestSetupLinkDto): Promise<void> {
    if ((dto.email === undefined) === (dto.setupToken === undefined)) {
      throw new BadRequestException(
        'Send either email or setupToken, not both',
      );
    }
    const email =
      dto.email ?? (await this.setupTokenAddress(dto.setupToken ?? ''));
    if (!email) return;

    const jobId = await this.prisma.$transaction(async (tx) => {
      await this.emails.lockAddress(tx, email);
      const account = await tx.storefrontAccount.findUnique({
        where: { email },
        select: { id: true },
      });
      if (account) return null;
      const order = await tx.order.findFirst({
        where: { confirmationEmail: email, confirmationStatus: 'CONFIRMED' },
        orderBy: [{ confirmedAt: 'desc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (!order) return null;
      if (!(await this.emails.mayEmail(tx, 'ACCOUNT_SETUP_LINK', email))) {
        return null;
      }
      const job = await this.emails.enqueueSetupLink(tx, {
        email,
        orderId: order.id,
        expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS),
      });
      return job.jobId;
    });
    if (jobId) this.outbox.dispatchAfterCommit(jobId);
  }

  /** Emails a password reset link if the address has an account. */
  async requestPasswordReset(email: string): Promise<void> {
    const jobId = await this.prisma.$transaction(async (tx) => {
      await this.emails.lockAddress(tx, email);
      const account = await tx.storefrontAccount.findUnique({
        where: { email },
        select: { id: true },
      });
      if (!account) return null;
      if (
        !(await this.emails.mayEmail(tx, 'STOREFRONT_PASSWORD_RESET', email))
      ) {
        return null;
      }
      // Only the newest reset link works; the older ones' emails, if still
      // queued, are dropped when they come up.
      await voidStorefrontTokens(tx, {
        purpose: 'PASSWORD_RESET',
        accountId: account.id,
      });
      const job = await this.emails.enqueuePasswordReset(tx, {
        accountId: account.id,
        email,
        expiresAt: new Date(Date.now() + STOREFRONT_PASSWORD_RESET_TTL_MS),
      });
      return job.jobId;
    });
    if (jobId) this.outbox.dispatchAfterCommit(jobId);
  }

  /**
   * Sets a new password from a reset link. One transaction: the token is used
   * (once, whatever the concurrency), the password replaced, the account's
   * other reset links voided and every one of its sessions ended, so whoever
   * knew the old password is signed out everywhere. No session is started:
   * the shopper signs in with the new password.
   */
  async resetPassword(dto: StorefrontResetPasswordDto): Promise<void> {
    if (dto.password !== dto.confirmPassword) throw passwordMismatch();
    const found = await checkStorefrontToken(
      this.prisma,
      dto.token,
      'PASSWORD_RESET',
    );
    if (found.status !== 'valid' || !found.record.accountId) {
      throw resetTokenInvalid();
    }
    const lockId = found.record.accountId;

    const passwordHash = await this.passwords.hash(dto.password);
    await this.prisma.$transaction(async (tx) => {
      // The account's row first: two resets of one account then run one after
      // another, instead of each holding a token the other is voiding.
      await tx.$queryRaw`SELECT "id" FROM "StorefrontAccount" WHERE "id" = ${lockId} FOR UPDATE`;
      const consumed = await consumeStorefrontToken(
        tx,
        dto.token,
        'PASSWORD_RESET',
      );
      if (
        consumed.status !== 'consumed' ||
        consumed.record.accountId !== lockId
      ) {
        throw resetTokenInvalid();
      }
      const accountId = lockId;
      const { count } = await tx.storefrontAccount.updateMany({
        where: { id: accountId, email: consumed.record.email },
        data: { passwordHash },
      });
      if (count === 0) throw resetTokenInvalid();
      await voidStorefrontTokens(tx, { purpose: 'PASSWORD_RESET', accountId });
      await this.sessions.revokeAllForAccount(accountId, 'PASSWORD_RESET', tx);
    });
  }

  /** The address an account setup token was issued for, whatever its state. */
  private async setupTokenAddress(token: string): Promise<string | null> {
    const found = await checkStorefrontToken(
      this.prisma,
      token,
      'ACCOUNT_SETUP',
    );
    return found.status === 'invalid' ? null : found.record.email;
  }
}
