import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import {
  publicUserSelect,
  toPublicUser,
  type PublicUser,
} from '../users/public-user';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';
import { SessionsService, type SessionMeta } from './sessions.service';
import { TokenService } from './token.service';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: PublicUser;
}

/** The refresh token travels only in an HttpOnly cookie, never in the JSON body. */
export interface AuthResult {
  body: AuthResponse;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  async login(dto: LoginDto, meta: SessionMeta): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Always verify (against a dummy hash if needed) so timing and the error
    // are identical for unknown accounts, wrong passwords and disabled accounts.
    const passwordOk = await this.passwords.verify(
      user?.passwordHash ?? null,
      dto.password,
    );
    if (!user || !passwordOk || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const now = new Date();
    const [session, updated] = await Promise.all([
      this.sessions.create(user.id, meta),
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now },
        select: publicUserSelect,
      }),
    ]);
    return this.issue(toPublicUser(updated), session);
  }

  async refresh(refreshToken: string, meta: SessionMeta): Promise<AuthResult> {
    const session = await this.sessions.rotate(refreshToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: session.userId },
      select: publicUserSelect,
    });
    return this.issue(user, session);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) {
      await this.sessions.revokeByRefreshToken(refreshToken, 'LOGOUT');
    }
  }

  async changePassword(
    user: AuthenticatedUser,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const record = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (
      !(await this.passwords.verify(record.passwordHash, dto.currentPassword))
    ) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'New password must differ from the current password',
      );
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      // A pending reset link would otherwise still work with the old password's authority.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', {
        exceptSessionId: user.sessionId,
        db: tx,
      });
    });
  }

  private async issue(
    user: PublicUser,
    session: { sessionId: string; refreshToken: string },
  ): Promise<AuthResult> {
    const { accessToken, expiresIn } = await this.tokens.signAccessToken(
      user.id,
      session.sessionId,
    );
    return {
      body: { accessToken, tokenType: 'Bearer', expiresIn, user },
      refreshToken: session.refreshToken,
    };
  }
}
