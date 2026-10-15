import type { PrismaService } from '../prisma/prisma.service';
import type { PublicUser } from '../users/public-user';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { SessionsService } from './sessions.service';
import type { TokenService } from './token.service';

describe('AuthService refresh', () => {
  it('issues the response from the public user already loaded during rotation', async () => {
    const user: PublicUser = {
      id: 'user-id',
      name: 'Staff',
      email: 'staff@example.com',
      role: 'STAFF',
      emailVerifiedAt: new Date(),
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const rotate = jest.fn().mockResolvedValue({
      sessionId: 'session-id',
      userId: user.id,
      refreshToken: 'rotated-refresh',
      user,
    });
    const findUniqueOrThrow = jest.fn();
    const signAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'access-token',
      expiresIn: 900,
    });
    const service = new AuthService(
      { user: { findUniqueOrThrow } } as unknown as PrismaService,
      {} as PasswordService,
      { signAccessToken } as unknown as TokenService,
      { rotate } as unknown as SessionsService,
    );
    const meta = { ipAddress: '127.0.0.1' };

    expect(await service.refresh('original-refresh', meta)).toEqual({
      body: {
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        user,
      },
      refreshToken: 'rotated-refresh',
    });
    expect(rotate).toHaveBeenCalledWith('original-refresh', meta);
    expect(signAccessToken).toHaveBeenCalledWith(user.id, 'session-id');
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
