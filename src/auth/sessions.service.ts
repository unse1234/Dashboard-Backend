import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { generateToken, safeEqual, sha256 } from '../common/crypto.util';
import { measureOperation } from '../common/observability/request-timing';
import { Prisma, type SessionRevokeReason } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { toPublicUser, type PublicUser } from '../users/public-user';

/**
 * A refresh request that presents the token this session just rotated away from
 * is most likely a second tab that lost a race, not theft, if it arrives this soon.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep user fields flat: PostgreSQL date columns then remain Date objects rather
// than becoming strings inside a JSON projection. Never select passwordHash.
const sessionUserColumns = Prisma.sql`
  s."id" AS "sessionId", s."userId",
  u."id", u."name", u."email", u."role", u."emailVerifiedAt",
  u."isActive", u."lastLoginAt", u."createdAt", u."updatedAt"
`;

interface SessionUserRow extends PublicUser {
  sessionId: string;
  userId: string;
}

interface RotationRow extends SessionUserRow {
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotatedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * A refresh attempt lost a benign race. Callers should reject it without
 * clearing the cookie, because the winning request already set a fresh one.
 */
export class RefreshRaceException extends UnauthorizedException {}

export interface SessionMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedSession {
  sessionId: string;
  userId: string;
  /** "<sessionId>.<secret>"; only the secret's hash is stored. */
  refreshToken: string;
}

export interface RotatedSession extends IssuedSession {
  user: PublicUser;
}

export interface SessionSummary {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

@Injectable()
export class SessionsService {
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs =
      config.getOrThrow('REFRESH_TOKEN_TTL_DAYS', { infer: true }) *
      24 *
      60 *
      60 *
      1000;
  }

  async create(userId: string, meta: SessionMeta): Promise<IssuedSession> {
    const secret = generateToken();
    const session = await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: sha256(secret),
        expiresAt: new Date(Date.now() + this.ttlMs),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      select: { id: true },
    });
    return {
      sessionId: session.id,
      userId,
      refreshToken: `${session.id}.${secret}`,
    };
  }

  /**
   * Exchanges a refresh token for a new one. The old token stops working
   * immediately; presenting it again later revokes the whole session.
   */
  async rotate(
    refreshToken: string,
    meta: SessionMeta,
  ): Promise<RotatedSession> {
    const parsed = this.parse(refreshToken);
    if (!parsed) throw this.invalidRefresh();

    // A relation include can issue separate session/user SELECTs. Join once and
    // carry this public user through refresh instead of reading it again later.
    const [session] = await measureOperation(
      'session_lookup',
      () => this.prisma.$queryRaw<RotationRow[]>`
      SELECT ${sessionUserColumns},
             s."refreshTokenHash", s."previousRefreshTokenHash",
             s."rotatedAt", s."expiresAt", s."revokedAt"
      FROM "Session" s
      JOIN "User" u ON u."id" = s."userId"
      WHERE s."id" = ${parsed.sessionId}
    `,
    );
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !session.isActive
    ) {
      throw this.invalidRefresh();
    }

    const presented = sha256(parsed.secret);

    if (safeEqual(presented, session.refreshTokenHash)) {
      const secret = generateToken();
      // The WHERE on the current hash makes the swap atomic: of two concurrent
      // requests with the same token, only one updates a row.
      const { count } = await measureOperation('session_rotate', () =>
        this.prisma.session.updateMany({
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
            expiresAt: new Date(now.getTime() + this.ttlMs),
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
        }),
      );
      if (count === 0) throw new RefreshRaceException('Invalid refresh token');
      return {
        sessionId: session.sessionId,
        userId: session.userId,
        refreshToken: `${session.sessionId}.${secret}`,
        user: toPublicUser(session),
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

    // A stale token outside the grace window: assume it was stolen and kill the session.
    await this.revoke(session.sessionId, 'REUSE_DETECTED');
    throw this.invalidRefresh();
  }

  /** Looks up a live session together with its (active) user in one query. */
  async findActive(
    sessionId: string,
  ): Promise<{ id: string; userId: string; user: PublicUser } | null> {
    if (!UUID_PATTERN.test(sessionId)) return null;
    const [session] = await measureOperation(
      'session_lookup',
      () => this.prisma.$queryRaw<SessionUserRow[]>`
      SELECT ${sessionUserColumns}
      FROM "Session" s
      JOIN "User" u ON u."id" = s."userId"
      WHERE s."id" = ${sessionId}
        AND s."revokedAt" IS NULL
        AND s."expiresAt" > ${new Date()}
        AND u."isActive" = TRUE
    `,
    );
    return session
      ? {
          id: session.sessionId,
          userId: session.userId,
          user: toPublicUser(session),
        }
      : null;
  }

  async listForUser(
    userId: string,
    currentSessionId: string,
  ): Promise<SessionSummary[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revoke(
    sessionId: string,
    reason: SessionRevokeReason,
    db: Db = this.prisma,
  ): Promise<void> {
    await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Logout: only a caller holding a valid (current or just-rotated) secret can revoke. */
  async revokeByRefreshToken(
    refreshToken: string,
    reason: SessionRevokeReason,
  ): Promise<void> {
    const parsed = this.parse(refreshToken);
    if (!parsed) return;
    const hash = sha256(parsed.secret);
    await this.prisma.session.updateMany({
      where: {
        id: parsed.sessionId,
        revokedAt: null,
        OR: [{ refreshTokenHash: hash }, { previousRefreshTokenHash: hash }],
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string; db?: Db } = {},
  ): Promise<void> {
    const db = options.db ?? this.prisma;
    await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId
          ? { id: { not: options.exceptSessionId } }
          : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revokes a session only if it belongs to the caller; anything else is a 404. */
  async revokeOwned(userId: string, sessionId: string): Promise<void> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' },
    });
    if (count === 0) throw new NotFoundException('Session not found');
  }

  private parse(
    refreshToken: string,
  ): { sessionId: string; secret: string } | null {
    const separator = refreshToken.indexOf('.');
    if (separator === -1) return null;
    const sessionId = refreshToken.slice(0, separator);
    const secret = refreshToken.slice(separator + 1);
    if (!UUID_PATTERN.test(sessionId) || secret.length === 0) return null;
    return { sessionId, secret };
  }

  private invalidRefresh(): UnauthorizedException {
    return new UnauthorizedException('Invalid refresh token');
  }
}
