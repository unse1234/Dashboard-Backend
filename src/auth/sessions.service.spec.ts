import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { sha256 } from '../common/crypto.util';
import type { Env } from '../config/env.validation';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PublicUser } from '../users/public-user';
import {
  REFRESH_REUSE_GRACE_MS,
  RefreshRaceException,
  SessionsService,
} from './sessions.service';

const SESSION_ID = 'f2f2c046-cc31-4d0a-a11a-098232e80535';
const SECRET = 'current-refresh-secret';
const NOW = new Date('2026-10-15T08:00:00.000Z');
const USER: PublicUser = {
  id: '1943845e-a947-46b7-9365-32a573ea5708',
  name: 'Test Staff',
  email: 'staff@example.com',
  role: 'STAFF',
  isActive: true,
  emailVerifiedAt: NOW,
  lastLoginAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function rotationRow() {
  return {
    ...USER,
    sessionId: SESSION_ID,
    userId: USER.id,
    refreshTokenHash: sha256(SECRET),
    previousRefreshTokenHash: null as string | null,
    rotatedAt: null as Date | null,
    revokedAt: null as Date | null,
    expiresAt: new Date(NOW.getTime() + 60_000),
  };
}

describe('SessionsService joined session lookups', () => {
  const queryRaw = jest.fn();
  const updateMany = jest.fn();
  const prisma = {
    $queryRaw: queryRaw,
    session: { updateMany },
  } as unknown as PrismaService;
  const config = {
    getOrThrow: () => 7,
  } as unknown as ConfigService<Env, true>;
  let service: SessionsService;

  const firstQuery = () =>
    Prisma.sql(...(queryRaw.mock.calls[0] as Parameters<typeof Prisma.sql>));

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.clearAllMocks();
    queryRaw.mockResolvedValue([rotationRow()]);
    updateMany.mockResolvedValue({ count: 1 });
    service = new SessionsService(prisma, config);
  });

  afterEach(() => jest.useRealTimers());

  it('rotates atomically after one joined read and returns only public user fields', async () => {
    const result = await service.rotate(`${SESSION_ID}.${SECRET}`, {
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = firstQuery();
    expect(query.text).toContain('JOIN "User" u ON u."id" = s."userId"');
    expect(query.text).not.toContain(SESSION_ID);
    expect(query.text).not.toContain('passwordHash');
    expect(query.values).toEqual([SESSION_ID]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const rotatedSecret = result.refreshToken.split('.')[1];
    expect(rotatedSecret).not.toBe(SECRET);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: SESSION_ID,
        refreshTokenHash: sha256(SECRET),
        revokedAt: null,
      },
      data: {
        refreshTokenHash: sha256(rotatedSecret),
        previousRefreshTokenHash: sha256(SECRET),
        rotatedAt: NOW,
        lastUsedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
      },
    });
    expect(result).toEqual({
      sessionId: SESSION_ID,
      userId: USER.id,
      refreshToken: `${SESSION_ID}.${rotatedSecret}`,
      user: USER,
    });
    expect(result.user.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['missing session', undefined],
    ['revoked session', { ...rotationRow(), revokedAt: NOW }],
    ['expired session', { ...rotationRow(), expiresAt: NOW }],
    ['disabled account', { ...rotationRow(), isActive: false }],
  ])('rejects %s before rotating', async (_name, row) => {
    queryRaw.mockResolvedValue(row ? [row] : []);

    await expect(
      service.rotate(`${SESSION_ID}.${SECRET}`, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects malformed credentials without a database lookup', async () => {
    await expect(
      service.rotate('not-a-session.secret', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('allows one concurrent rotation to win without revoking the session', async () => {
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      service.rotate(`${SESSION_ID}.${SECRET}`, {}),
      service.rotate(`${SESSION_ID}.${SECRET}`, {}),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(
      RefreshRaceException,
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls.every(([args]) => !args.data.revokedAt)).toBe(
      true,
    );
  });

  it('keeps a just-rotated previous token within the grace window from revoking the session', async () => {
    queryRaw.mockResolvedValue([
      {
        ...rotationRow(),
        refreshTokenHash: sha256('new-secret'),
        previousRefreshTokenHash: sha256(SECRET),
        rotatedAt: new Date(NOW.getTime() - REFRESH_REUSE_GRACE_MS),
      },
    ]);

    await expect(
      service.rotate(`${SESSION_ID}.${SECRET}`, {}),
    ).rejects.toBeInstanceOf(RefreshRaceException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokes a session when its previous token is reused outside the grace window', async () => {
    queryRaw.mockResolvedValue([
      {
        ...rotationRow(),
        refreshTokenHash: sha256('new-secret'),
        previousRefreshTokenHash: sha256(SECRET),
        rotatedAt: new Date(NOW.getTime() - REFRESH_REUSE_GRACE_MS - 1),
      },
    ]);

    await expect(
      service.rotate(`${SESSION_ID}.${SECRET}`, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, revokedAt: null },
      data: { revokedAt: NOW, revokedReason: 'REUSE_DETECTED' },
    });
  });

  it('checks current session revocation, expiry and active user in one parameterized lookup', async () => {
    const result = await service.findActive(SESSION_ID);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = firstQuery();
    expect(query.text).toContain('JOIN "User" u ON u."id" = s."userId"');
    expect(query.text).toContain('s."revokedAt" IS NULL');
    expect(query.text).toContain('s."expiresAt" > $2');
    expect(query.text).toContain('u."isActive" = TRUE');
    expect(query.text).not.toContain('refreshTokenHash');
    expect(query.text).not.toContain('passwordHash');
    expect(query.values).toEqual([SESSION_ID, NOW]);
    expect(result).toEqual({ id: SESSION_ID, userId: USER.id, user: USER });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not cache live-session checks across requests', async () => {
    queryRaw.mockResolvedValueOnce([rotationRow()]).mockResolvedValueOnce([]);

    expect(await service.findActive(SESSION_ID)).not.toBeNull();
    expect(await service.findActive(SESSION_ID)).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed session ID without a database lookup', async () => {
    expect(await service.findActive('not-a-session')).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
