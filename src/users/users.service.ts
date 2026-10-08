import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

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
    // Self-service on role/status would allow an admin to lock themselves out
    // or, for a compromised account, to cover its tracks.
    if (
      actor.id === id &&
      ((dto.role !== undefined && dto.role !== actor.role) ||
        dto.isActive === false)
    ) {
      throw new ForbiddenException('You cannot change your own role or status');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockAdminMembership(tx);

      const target = await tx.user.findUnique({
        where: { id },
        select: publicUserSelect,
      });
      if (!target) throw new NotFoundException('User not found');

      const losesAdminAccess =
        target.role === 'ADMIN' &&
        target.isActive &&
        (dto.role === 'STAFF' || dto.isActive === false);
      if (losesAdminAccess) {
        const otherAdmins = await tx.user.count({
          where: { role: 'ADMIN', isActive: true, id: { not: id } },
        });
        if (otherAdmins === 0) {
          throw new ConflictException('At least one active admin is required');
        }
      }

      const updated = await tx.user.update({
        where: { id },
        data: { name: dto.name, role: dto.role, isActive: dto.isActive },
        select: publicUserSelect,
      });
      if (target.isActive && dto.isActive === false) {
        await this.sessions.revokeAllForUser(id, 'ACCOUNT_DISABLED', {
          db: tx,
        });
      }
      return updated;
    });
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
