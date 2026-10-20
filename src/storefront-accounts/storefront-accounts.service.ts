import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { PasswordService } from '../auth/password.service';
import type { SessionMeta } from '../auth/sessions.service';
import { BusinessException } from '../common/business-error';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkStorefrontToken,
  consumeStorefrontToken,
  voidStorefrontTokens,
  type StorefrontTokenCheck,
  type StorefrontTokenConsumption,
} from '../storefront-tokens/storefront-tokens';
import type {
  AccountSetupDto,
  StorefrontSignInDto,
} from './dto/storefront-account.dto';
import { linkVerifiedOrders } from './order-ownership';
import { StorefrontAccessTokenService } from './storefront-access-token.service';
import {
  StorefrontSessionsService,
  type StorefrontAccountProfile,
} from './storefront-sessions.service';

/** What a signed-in shopper is told about their own account. */
export interface StorefrontAccountView {
  email: string;
  createdAt: string;
}

/** The body of every answer that starts or renews a storefront session. */
export interface StorefrontAuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
  account: StorefrontAccountView;
}

/** The refresh token travels only in the HttpOnly cookie, never in the body. */
export interface StorefrontAuthResult {
  body: StorefrontAuthResponse;
  refreshToken: string;
}

/** What a setup permission allows, before it is used. */
export interface AccountSetupPreview {
  /**
   * READY: a password may be chosen. ACCOUNT_EXISTS: the address has an
   * account already (made since the permission was given): sign in instead.
   */
  status: 'READY' | 'ACCOUNT_EXISTS';
  /** The address the account is for: the one the permission was issued to. */
  email: string;
  expiresAt: string;
}

export const toAccountView = (
  account: Pick<StorefrontAccountProfile, 'email' | 'createdAt'>,
): StorefrontAccountView => ({
  email: account.email,
  createdAt: account.createdAt.toISOString(),
});

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);

const setupTokenInvalid = () =>
  new BusinessException(
    HttpStatus.NOT_FOUND,
    'SETUP_TOKEN_INVALID',
    'This account setup link is not valid any more. If you have already set up your account, sign in.',
  );

const setupTokenExpired = () =>
  new BusinessException(
    HttpStatus.GONE,
    'SETUP_TOKEN_EXPIRED',
    'The time to set up your account with this link has run out. Ask for a new link and we will email it to you.',
  );

export const accountExists = () =>
  new BusinessException(
    HttpStatus.CONFLICT,
    'ACCOUNT_EXISTS',
    'An account already exists for this email address. Sign in, or reset your password if you have forgotten it.',
  );

export const passwordMismatch = () =>
  new BusinessException(
    HttpStatus.BAD_REQUEST,
    'PASSWORD_MISMATCH',
    'The passwords do not match.',
  );

/** Unknown, malformed, used or replaced: 404; only past its time: 410. */
function refuseSetupToken(
  result: StorefrontTokenCheck | StorefrontTokenConsumption,
): never {
  throw result.status === 'expired' ? setupTokenExpired() : setupTokenInvalid();
}

/**
 * Storefront accounts: creating one from a setup permission, and the session
 * that follows (sign in, refresh, sign out).
 *
 * An account is only ever created for an address an emailed link proved: the
 * address comes from the setup token, which was issued for an order's
 * confirmation address (immutable in the database) or by a setup link sent to
 * it. A request never names the address, and setup never touches an account
 * that exists: it refuses instead, so no password is ever overwritten here.
 */
@Injectable()
export class StorefrontAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: StorefrontAccessTokenService,
    private readonly sessions: StorefrontSessionsService,
  ) {}

  /** What a setup token allows. Reads only: the token stays unused. */
  async previewSetup(setupToken: string): Promise<AccountSetupPreview> {
    const found = await checkStorefrontToken(
      this.prisma,
      setupToken,
      'ACCOUNT_SETUP',
    );
    if (found.status !== 'valid') refuseSetupToken(found);
    const { email, expiresAt } = found.record;
    const account = await this.prisma.storefrontAccount.findUnique({
      where: { email },
      select: { id: true },
    });
    return {
      status: account ? 'ACCOUNT_EXISTS' : 'READY',
      email,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Creates the account and signs it in. One transaction: the token is used
   * by a conditional UPDATE (of concurrent attempts with one token, exactly
   * one gets it), the account is inserted with ON CONFLICT DO NOTHING on the
   * unique address (of concurrent attempts for one address, exactly one
   * inserts), the address's confirmed orders become the account's, its other
   * setup tokens stop working, and the session starts. If the address already
   * has an account, all of it rolls back, the token included, and the answer
   * is 409.
   */
  async setup(
    dto: AccountSetupDto,
    meta: SessionMeta,
  ): Promise<StorefrontAuthResult> {
    if (dto.password !== dto.confirmPassword) throw passwordMismatch();

    // Cheap refusals first, so a bad token or a taken address costs no Argon2.
    const found = await checkStorefrontToken(
      this.prisma,
      dto.setupToken,
      'ACCOUNT_SETUP',
    );
    if (found.status !== 'valid') refuseSetupToken(found);
    const taken = await this.prisma.storefrontAccount.findUnique({
      where: { email: found.record.email },
      select: { id: true },
    });
    if (taken) throw accountExists();

    // Hash before the transaction: Argon2 is slow and must not hold locks.
    const passwordHash = await this.passwords.hash(dto.password);

    // A token's address never changes, so it can be locked before the token
    // is used. Setups for one address then run one after another: without
    // this, two of them with different tokens could each hold the token the
    // other is about to void, and deadlock.
    const { email } = found.record;
    const { account, session } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-setup:${email}`}))`;
      // A setup that finished while this one waited made the account: say so
      // (409) rather than that the token, which it voided, is not valid.
      const existing = await tx.storefrontAccount.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing) throw accountExists();
      const consumed = await consumeStorefrontToken(
        tx,
        dto.setupToken,
        'ACCOUNT_SETUP',
      );
      if (consumed.status !== 'consumed') refuseSetupToken(consumed);

      const [created] = await tx.$queryRaw<StorefrontAccountProfile[]>`
        INSERT INTO "StorefrontAccount" ("id", "email", "passwordHash",
          "emailVerifiedAt", "lastLoginAt", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${email}, ${passwordHash}, ${NOW_UTC},
          ${NOW_UTC}, ${NOW_UTC}, ${NOW_UTC})
        ON CONFLICT ("email") DO NOTHING
        RETURNING "id", "email", "createdAt"`;
      if (!created) throw accountExists();

      // The address's confirmed orders become the account's; nothing else.
      await linkVerifiedOrders(tx, created);
      await voidStorefrontTokens(tx, { purpose: 'ACCOUNT_SETUP', email });

      return {
        account: created,
        session: await this.sessions.create(created.id, meta, tx),
      };
    });
    return this.issue(account, session);
  }

  /** The same answer, at the same cost, for every failure. */
  async signIn(
    dto: StorefrontSignInDto,
    meta: SessionMeta,
  ): Promise<StorefrontAuthResult> {
    const account = await this.prisma.storefrontAccount.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, createdAt: true, passwordHash: true },
    });
    // Verified against a dummy hash when there is no account, so an unknown
    // address takes as long as a wrong password.
    const passwordOk = await this.passwords.verify(
      account?.passwordHash ?? null,
      dto.password,
    );
    if (!account || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const [session] = await Promise.all([
      this.sessions.create(account.id, meta),
      this.prisma.storefrontAccount.update({
        where: { id: account.id },
        data: { lastLoginAt: new Date() },
        select: { id: true },
      }),
    ]);
    return this.issue(account, session);
  }

  async refresh(
    refreshToken: string,
    meta: SessionMeta,
  ): Promise<StorefrontAuthResult> {
    const session = await this.sessions.rotate(refreshToken, meta);
    return this.issue(session.account, session);
  }

  async signOut(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) {
      await this.sessions.revokeByRefreshToken(refreshToken, 'LOGOUT');
    }
  }

  private async issue(
    account: StorefrontAccountProfile,
    session: { sessionId: string; refreshToken: string },
  ): Promise<StorefrontAuthResult> {
    const { accessToken, expiresIn } = await this.tokens.sign(
      account.id,
      session.sessionId,
    );
    return {
      body: {
        accessToken,
        tokenType: 'Bearer',
        expiresIn,
        account: toAccountView(account),
      },
      refreshToken: session.refreshToken,
    };
  }
}
