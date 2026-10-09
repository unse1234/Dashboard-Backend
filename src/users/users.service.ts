import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionsService } from '../auth/sessions.service';
import { RecoveryService } from '../auth/recovery.service';
import type { AuthenticatedUser } from '../common/authenticated-user';
import type { Env } from '../config/env.validation';
import { Prisma, type Role } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import type { InviteUserDto } from './dto/invite-user.dto';
import type { ListUsersQueryDto } from './dto/list-users-query.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { publicUserSelect, type PublicUser } from './public-user';

// Serializes anything that changes who the administrators are, so two admins
// demoting each other at the same moment cannot leave the system with none.
const ADMIN_MEMBERSHIP_LOCK = 7_410_001;

const HOUR_MS = 60 * 60 * 1000;

/** Prisma passes `contains` straight into LIKE, so make %, _ and \ match literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export interface InviteResult {
  user: PublicUser;
  /** False when the account exists but the email could not be delivered. */
  invitationSent: boolean;
}

export interface UserPage {
  data: PublicUser[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly invitationTtlHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: RecoveryService,
    private readonly sessions: SessionsService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.invitationTtlHours = config.getOrThrow('INVITATION_TTL_HOURS', {
      infer: true,
    });
  }

  /** Creates a staff or admin account and emails a set-password link. */
  invite(dto: InviteUserDto): Promise<InviteResult> {
    return this.createInvitation({
      name: dto.name,
      email: dto.email,
      role: dto.role ?? 'STAFF',
    });
  }

  /**
   * One-time creation of the first administrator (see the create-admin script).
   * Refuses to run while an active admin exists.
   */
  bootstrapAdmin(
    dto: Pick<InviteUserDto, 'name' | 'email'>,
  ): Promise<InviteResult> {
    return this.createInvitation(
      { name: dto.name, email: dto.email, role: 'ADMIN' },
      async (tx) => {
        await this.lockAdminMembership(tx);
        const admins = await tx.user.count({
          where: { role: 'ADMIN', isActive: true },
        });
        if (admins > 0) {
          throw new ConflictException(
            'An active admin already exists. Sign in and invite users from the dashboard.',
          );
        }
      },
    );
  }

  async list(query: ListUsersQueryDto): Promise<UserPage> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              {
                name: {
                  contains: escapeLike(query.search),
                  mode: 'insensitive',
                },
              },
              {
                email: {
                  contains: escapeLike(query.search),
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: publicUserSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      data,
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async get(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: publicUserSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Lets the signed-in user edit their own profile. Only the name is editable. */
  async updateProfile(
    actor: AuthenticatedUser,
    dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    try {
      return await this.prisma.user.update({
        where: { id: actor.id, deletedAt: null },
        data: { name: dto.name },
        select: publicUserSelect,
      });
    } catch (error) {
      // The account was deleted after the guard authenticated this request.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      throw error;
    }
  }

  /** Admin edit of name, role and/or status in one call. */
  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateUserDto,
  ): Promise<PublicUser> {
    if (
      dto.name === undefined &&
      dto.role === undefined &&
      dto.isActive === undefined
    ) {
      throw new BadRequestException('No changes supplied');
    }
    return this.applyChanges(actor, id, dto);
  }

  setActive(
    actor: AuthenticatedUser,
    id: string,
    isActive: boolean,
  ): Promise<PublicUser> {
    return this.applyChanges(actor, id, { isActive });
  }

  setRole(
    actor: AuthenticatedUser,
    id: string,
    role: Role,
  ): Promise<PublicUser> {
    return this.applyChanges(actor, id, { role });
  }

  /**
   * Soft delete: the row is kept so records that reference the user survive, but
   * the account is deactivated (which is what blocks sign-in; the database forbids a
   * deleted row from being active), its sessions are revoked and its unused email
   * links are voided. Deleted users disappear from every users endpoint.
   */
  async remove(actor: AuthenticatedUser, id: string): Promise<void> {
    if (actor.id === id) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    await this.asAdmin(actor, async (tx) => {
      const target = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: publicUserSelect,
      });
      if (!target) throw new NotFoundException('User not found');
      if (target.role === 'ADMIN' && target.isActive) {
        await this.assertAnotherActiveAdmin(tx, id);
      }

      const now = new Date();
      await tx.user.update({
        where: { id },
        data: { isActive: false, deletedAt: now },
      });
      await this.sessions.revokeAllForUser(id, 'ACCOUNT_DISABLED', { db: tx });
      // An outstanding invitation or reset link must not outlive the account.
      await tx.passwordResetToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: now },
      });
      await tx.emailVerificationToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: now },
      });
    });
  }

  /** The one place role and status changes happen, so every entry point obeys the same rules. */
  private async applyChanges(
    actor: AuthenticatedUser,
    id: string,
    changes: Pick<UpdateUserDto, 'name' | 'role' | 'isActive'>,
  ): Promise<PublicUser> {
    // Self-service on role/status would allow an admin to lock themselves out
    // or, for a compromised account, to cover its tracks.
    if (
      actor.id === id &&
      ((changes.role !== undefined && changes.role !== actor.role) ||
        changes.isActive === false)
    ) {
      throw new ForbiddenException('You cannot change your own role or status');
    }

    return this.asAdmin(actor, async (tx) => {
      const target = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: publicUserSelect,
      });
      if (!target) throw new NotFoundException('User not found');

      const losesAdminAccess =
        target.role === 'ADMIN' &&
        target.isActive &&
        ((changes.role !== undefined && changes.role !== 'ADMIN') ||
          changes.isActive === false);
      if (losesAdminAccess) await this.assertAnotherActiveAdmin(tx, id);

      const updated = await tx.user.update({
        where: { id },
        data: {
          name: changes.name,
          role: changes.role,
          isActive: changes.isActive,
        },
        select: publicUserSelect,
      });
      // A status change in either direction clears the user's sessions. Disabling
      // ends them. Re-enabling sweeps any that slipped in while the account was
      // off (a sign-in that raced the deactivation), so reactivation never revives
      // an old session and the user always starts from a fresh sign-in.
      if (target.isActive !== updated.isActive) {
        await this.sessions.revokeAllForUser(id, 'ACCOUNT_DISABLED', {
          db: tx,
        });
      }
      return updated;
    });
  }

  /**
   * Runs an account-changing operation inside the admin-membership lock, after
   * re-checking under that lock that the caller is still an active admin. The
   * guards ran earlier in the request, so without this an admin who was demoted
   * or removed a moment ago could still get an in-flight request through.
   */
  private asAdmin<T>(
    actor: AuthenticatedUser,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAdminMembership(tx);
      const stillAdmin = await tx.user.findFirst({
        where: {
          id: actor.id,
          role: 'ADMIN',
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!stillAdmin) throw new ForbiddenException('Insufficient permissions');
      return work(tx);
    });
  }

  private async assertAnotherActiveAdmin(
    tx: Db,
    excludingId: string,
  ): Promise<void> {
    const others = await tx.user.count({
      where: { role: 'ADMIN', isActive: true, id: { not: excludingId } },
    });
    if (others === 0) {
      throw new ConflictException('At least one active admin is required');
    }
  }

  private async createInvitation(
    data: { name: string; email: string; role: Role },
    precondition?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<InviteResult> {
    let created: { user: PublicUser; token: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        if (precondition) await precondition(tx);
        const user = await tx.user.create({ data, select: publicUserSelect });
        const token = await this.recovery.createPasswordToken(
          user.id,
          this.invitationTtlHours * HOUR_MS,
          tx,
        );
        return { user, token };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }

    let invitationSent = true;
    try {
      await this.mail.sendInvitation(
        created.user.email,
        created.user.name,
        created.token,
        this.invitationTtlHours,
      );
    } catch (error) {
      invitationSent = false;
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Failed to send invitation for user ${created.user.id}: ${reason}`,
      );
    }
    return { user: created.user, invitationSent };
  }

  private async lockAdminMembership(tx: Db): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_MEMBERSHIP_LOCK})`;
  }
}
