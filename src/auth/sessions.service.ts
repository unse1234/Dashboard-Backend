import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { generateToken, safeEqual, sha256 } from '../common/crypto.util';
import type { SessionRevokeReason } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { publicUserSelect, type PublicUser } from '../users/public-user';

/**
 * A refresh request that presents the token this session just rotated away from
 * is most likely a second tab that lost a race, not theft, if it arrives this soon.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  ): Promise<IssuedSession> {
    const parsed = this.parse(refreshToken);
    if (!parsed) throw this.invalidRefresh();

    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: { select: { isActive: true } } },
    });
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      !session.user.isActive
    ) {
      throw this.invalidRefresh();
    }

    const presented = sha256(parsed.secret);

    if (safeEqual(presented, session.refreshTokenHash)) {
      const secret = generateToken();
      // The WHERE on the current hash makes the swap atomic: of two concurrent
      // requests with the same token, only one updates a row.
      const { count } = await this.prisma.session.updateMany({
        where: {
          id: session.id,
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
      });
      if (count === 0) throw new RefreshRaceException('Invalid refresh token');
      return {
        sessionId: session.id,
        userId: session.userId,
        refreshToken: `${session.id}.${secret}`,
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
    await this.revoke(session.id, 'REUSE_DETECTED');
    throw this.invalidRefresh();
  }

  /** Looks up a live session together with its (active) user in one query. */
  findActive(
    sessionId: string,
  ): Promise<{ id: string; userId: string; user: PublicUser } | null> {
    if (!UUID_PATTERN.test(sessionId)) return Promise.resolve(null);
    return this.prisma.session.findFirst({
      where: {
        id: sessionId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { isActive: true },
      },
      select: {
        id: true,
        userId: true,
        user: { select: publicUserSelect },
      },
    });
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
