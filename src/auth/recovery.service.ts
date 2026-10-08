import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../common/authenticated-user';
import { generateToken, sha256 } from '../common/crypto.util';
import type { Env } from '../config/env.validation';
import { MailService } from '../mail/mail.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';

/**
 * Minimum gap between emails for one account. Throttling is per address, so
 * this stops a distributed caller from flooding a victim's inbox.
 */
export const EMAIL_COOLDOWN_MS = 60_000;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const INVALID_TOKEN = 'Invalid or expired token';

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly resetTtlMs: number;
  private readonly resetTtlMinutes: number;
  private readonly verificationTtlMs: number;
  private readonly verificationTtlHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.resetTtlMinutes = config.getOrThrow('PASSWORD_RESET_TTL_MINUTES', {
      infer: true,
    });
    this.resetTtlMs = this.resetTtlMinutes * MINUTE_MS;
    this.verificationTtlHours = config.getOrThrow(
      'EMAIL_VERIFICATION_TTL_HOURS',
      { infer: true },
    );
    this.verificationTtlMs = this.verificationTtlHours * HOUR_MS;
  }

  /**
   * Creates a single-use password token and voids the user's earlier unused ones.
   * Used for password resets and (with a longer lifetime) staff invitations.
   * Only the token's hash is stored; the plaintext goes into the email.
   */
  async createPasswordToken(
    userId: string,
    ttlMs: number,
    db: Db = this.prisma,
  ): Promise<string> {
    const token = generateToken();
    await db.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.passwordResetToken.create({
      data: {
        userId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  /**
   * Always resolves the same way whether or not the account exists, so the
   * endpoint cannot be used to discover registered addresses. The email is sent
   * in the background to keep response times alike.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, isActive: true },
    });
    if (!user?.isActive) return;
    if (await this.sentRecently('password', user.id)) return;

    const token = await this.createPasswordToken(user.id, this.resetTtlMs);
    void this.mail
      .sendPasswordReset(user.email, user.name, token, this.resetTtlMinutes)
      .catch((error: unknown) =>
        this.logMailFailure('password reset', user.id, error),
      );
  }

  async resetPassword(token: string, password: string): Promise<void> {
    // Hash before opening the transaction: Argon2 is slow and must not hold locks.
    const passwordHash = await this.passwords.hash(password);
    const tokenHash = sha256(token);

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Conditional update = atomic single use, even for concurrent requests.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count === 0) throw new BadRequestException(INVALID_TOKEN);

      const { userId } = await tx.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { userId: true },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { isActive: true, emailVerifiedAt: true },
      });
      if (!user.isActive) throw new BadRequestException(INVALID_TOKEN);

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          // Following an emailed link proves control of the address.
          emailVerifiedAt: user.emailVerifiedAt ?? now,
        },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.emailVerificationToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      });
      await this.sessions.revokeAllForUser(userId, 'PASSWORD_RESET', {
        db: tx,
      });
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = sha256(token);

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const consumed = await tx.emailVerificationToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count === 0) throw new BadRequestException(INVALID_TOKEN);

      const { userId } = await tx.emailVerificationToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { userId: true },
      });
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
    });
  }

  /** Requires authentication, so it cannot be used to probe for registered emails. */
  async resendVerification(user: AuthenticatedUser): Promise<void> {
    if (user.emailVerifiedAt) return;
    if (await this.sentRecently('verification', user.id)) return;

    const token = generateToken();
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + this.verificationTtlMs),
        },
      }),
    ]);
    void this.mail
      .sendEmailVerification(
        user.email,
        user.name,
        token,
        this.verificationTtlHours,
      )
      .catch((error: unknown) =>
        this.logMailFailure('verification', user.id, error),
      );
  }

  private async sentRecently(
    kind: 'password' | 'verification',
    userId: string,
  ): Promise<boolean> {
    const where = {
      userId,
      createdAt: { gt: new Date(Date.now() - EMAIL_COOLDOWN_MS) },
    };
    const recent =
      kind === 'password'
        ? await this.prisma.passwordResetToken.findFirst({ where })
        : await this.prisma.emailVerificationToken.findFirst({ where });
    return recent !== null;
  }

  // Never log the recipient address or token; the user id is enough to investigate.
  private logMailFailure(kind: string, userId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : 'unknown error';
    this.logger.error(
      `Failed to send ${kind} email for user ${userId}: ${reason}`,
    );
  }
}
