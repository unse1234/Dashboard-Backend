import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  REFRESH_REUSE_GRACE_MS,
  RefreshRaceException,
  type SessionMeta,
} from '../auth/sessions.service';
import { generateToken, safeEqual, sha256 } from '../common/crypto.util';
import type { SessionRevokeReason } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { StorefrontSessionSettings } from './storefront-account.settings';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a signed-in shopper may see of their own account. */
export interface StorefrontAccountProfile {
  id: string;
  email: string;
  createdAt: Date;
}

export interface IssuedStorefrontSession {
  sessionId: string;
  /** "<sessionId>.<secret>"; only the secret's hash is stored. */
  refreshToken: string;
}

export interface RotatedStorefrontSession extends IssuedStorefrontSession {
  account: StorefrontAccountProfile;
}

interface SessionAccountRow {
  sessionId: string;
  accountId: string;
  email: string;
  createdAt: Date;
}

interface RotationRow extends SessionAccountRow {
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotatedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

const toProfile = (row: SessionAccountRow): StorefrontAccountProfile => ({
  id: row.accountId,
  email: row.email,
  createdAt: row.createdAt,
});

/**
 * Storefront refresh sessions. The same rules as the staff SessionsService
 * (rotation on every use, a short grace for a second tab that lost the race,
 * revocation when an older token comes back), on StorefrontSession and
 * StorefrontAccount only: no staff session or user is ever read here, and no
 * storefront session is ever read by the staff side.
 */
@Injectable()
export class StorefrontSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: StorefrontSessionSettings,
  ) {}

  /** Starts a session; in the caller's transaction when given one. */
  async create(
    accountId: string,
    meta: SessionMeta,
    db: Db = this.prisma,
  ): Promise<IssuedStorefrontSession> {
    const secret = generateToken();
    const session = await db.storefrontSession.create({
      data: {
        accountId,
        refreshTokenHash: sha256(secret),
        expiresAt: new Date(Date.now() + this.settings.sessionTtlMs),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      select: { id: true },
    });
    return {
      sessionId: session.id,
      refreshToken: `${session.id}.${secret}`,
    };
  }

  /**
   * Exchanges a refresh token for a new one. The old token stops working at
   * once; presenting it again after the grace period ends the session.
   */
  async rotate(
    refreshToken: string,
    meta: SessionMeta,
  ): Promise<RotatedStorefrontSession> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw invalidRefresh();

    const [session] = await this.prisma.$queryRaw<RotationRow[]>`
      SELECT s."id" AS "sessionId", s."accountId", a."email", a."createdAt",
             s."refreshTokenHash", s."previousRefreshTokenHash",
             s."rotatedAt", s."expiresAt", s."revokedAt"
      FROM "StorefrontSession" s
      JOIN "StorefrontAccount" a ON a."id" = s."accountId"
      WHERE s."id" = ${parsed.sessionId}`;
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw invalidRefresh();
    }

    const presented = sha256(parsed.secret);
    if (safeEqual(presented, session.refreshTokenHash)) {
      const secret = generateToken();
      // The WHERE on the current hash makes the swap atomic: of two requests
      // with the same token, only one updates the row.
      const { count } = await this.prisma.storefrontSession.updateMany({
        where: {
          id: session.sessionId,
          refreshTokenHash: session.refreshTokenHash,
          revokedAt: null,
        },
        data: {
          refreshTokenHash: sha256(secret),
          previousRefreshTokenHash: session.refreshTokenHash,
          rotatedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now.getTime() + this.settings.sessionTtlMs),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      if (count === 0) throw new RefreshRaceException('Invalid refresh token');
      return {
        sessionId: session.sessionId,
        refreshToken: `${session.sessionId}.${secret}`,
        account: toProfile(session),
      };
    }

    if (
      session.previousRefreshTokenHash &&
      session.rotatedAt &&
      now.getTime() - session.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS &&
      safeEqual(presented, session.previousRefreshTokenHash)
    ) {
      throw new RefreshRaceException('Invalid refresh token');
    }

    // An older token outside the grace period: assume it was stolen.
    await this.prisma.storefrontSession.updateMany({
      where: { id: session.sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'REUSE_DETECTED' },
    });
    throw invalidRefresh();
  }

  /** A live session together with its account, in one query. */
  async findActive(
    sessionId: string,
  ): Promise<{ id: string; account: StorefrontAccountProfile } | null> {
    if (!UUID_PATTERN.test(sessionId)) return null;
    const [session] = await this.prisma.$queryRaw<SessionAccountRow[]>`
      SELECT s."id" AS "sessionId", s."accountId", a."email", a."createdAt"
      FROM "StorefrontSession" s
      JOIN "StorefrontAccount" a ON a."id" = s."accountId"
      WHERE s."id" = ${sessionId}
        AND s."revokedAt" IS NULL
        AND s."expiresAt" > ${new Date()}`;
    return session
      ? { id: session.sessionId, account: toProfile(session) }
      : null;
  }

  /** Sign-out: only a caller holding the current (or just-rotated) secret can end it. */
  async revokeByRefreshToken(
    refreshToken: string,
    reason: SessionRevokeReason,
  ): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const hash = sha256(parsed.secret);
    await this.prisma.storefrontSession.updateMany({
      where: {
        id: parsed.sessionId,
        revokedAt: null,
        OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }],
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Ends every session of an account (a password reset). */
  async revokeAllForAccount(
    accountId: string,
    reason: SessionRevokeReason,
    db: Db = this.prisma,
  ): Promise<number> {
    const { count } = await db.storefrontSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return count;
  }
}

function parseRefreshToken(
  refreshToken: string,
): { sessionId: string; secret: string } | null {
  const separator = refreshToken.indexOf('.');
  if (separator === -1) return null;
  const sessionId = refreshToken.slice(0, separator);
  const secret = refreshToken.slice(separator + 1);
  if (!UUID_PATTERN.test(sessionId) || secret.length === 0) return null;
  return { sessionId, secret };
}

function invalidRefresh(): UnauthorizedException {
  return new UnauthorizedException('Invalid refresh token');
}
