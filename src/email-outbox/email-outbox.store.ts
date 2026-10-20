import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox } from '../common/secret-box';
import type { Env } from '../config/env.validation';
import { Prisma, type EmailJobType } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  EMAIL_JOB_LEASE_MS,
  EMAIL_JOB_MAX_ATTEMPTS,
  type SendFailure,
} from './email-outbox.policy';

/** A job this worker holds the lease on. */
export interface ClaimedEmailJob {
  id: string;
  type: EmailJobType;
  /** Lower-cased. */
  recipient: string;
  orderId: string | null;
  idempotencyKey: string;
  /** Including the attempt this claim is. */
  attempts: number;
  maxAttempts: number;
  /** This claim's lease; every write about the job is conditional on it. */
  lease: string;
  /**
   * The secrets the job was enqueued with, decrypted. Null when it had none,
   * or when they cannot be read (tampered, or sealed under another key).
   */
  secrets: Record<string, string> | null;
  /** True when the job carried secrets that could not be read. */
  secretsUnreadable: boolean;
}

interface ClaimRow {
  id: string;
  type: EmailJobType;
  recipient: string;
  orderId: string | null;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  protectedPayload: string | null;
}

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);
// A code constant, never request data, so it may be written into the SQL.
const LEASE = Prisma.raw(`interval '${EMAIL_JOB_LEASE_MS} milliseconds'`);

/**
 * The email outbox's storage. An email is recorded in the same transaction as
 * the change that needs it, so it exists exactly when that change does, and it
 * survives restarts until a worker has sent it (or given up).
 *
 * Secrets a message needs later (a link token) are sealed with authenticated
 * encryption bound to the job's idempotency key, and erased as soon as the job
 * is no longer pending; a CHECK in the migration makes "no longer pending,
 * still holding secrets" impossible.
 */
@Injectable()
export class EmailOutboxStore {
  private readonly box: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.box = new SecretBox(
      config.getOrThrow('JWT_ACCESS_SECRET', { infer: true }),
      'email-outbox-payload/v1',
    );
  }

  /**
   * Records an email to send. Recording the same `idempotencyKey` again does
   * nothing and returns the job already recorded (`created: false`), whose
   * secrets are the ones it was first given.
   */
  async enqueue(
    db: Db,
    job: {
      type: EmailJobType;
      recipient: string;
      orderId: string | null;
      idempotencyKey: string;
      secrets?: Record<string, string>;
      maxAttempts?: number;
    },
  ): Promise<{ id: string; created: boolean }> {
    const payload = job.secrets
      ? this.box.seal(JSON.stringify(job.secrets), job.idempotencyKey)
      : null;
    const inserted = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO "EmailJob" ("id", "type", "status", "recipient", "orderId",
        "idempotencyKey", "maxAttempts", "protectedPayload", "nextAttemptAt",
        "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${job.type}::"EmailJobType", 'PENDING',
        ${job.recipient}, ${job.orderId}, ${job.idempotencyKey},
        ${job.maxAttempts ?? EMAIL_JOB_MAX_ATTEMPTS}, ${payload}, ${NOW_UTC},
        ${NOW_UTC}, ${NOW_UTC})
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING "id"`;
    if (inserted[0]) return { id: inserted[0].id, created: true };

    const existing = await db.emailJob.findUniqueOrThrow({
      where: { idempotencyKey: job.idempotencyKey },
      select: { id: true },
    });
    return { id: existing.id, created: false };
  }

  /**
   * Takes up to `limit` due jobs (or the one job `id`, if it is due) for this
   * worker: pending, their next attempt due, attempts left, and no live lease.
   * FOR UPDATE SKIP LOCKED makes concurrent workers take disjoint jobs, and the
   * lease keeps a job theirs after this statement commits. Each claim counts as
   * an attempt.
   */
  async claim(options: {
    limit: number;
    id?: string;
  }): Promise<ClaimedEmailJob[]> {
    const lease = randomUUID();
    const onlyId =
      options.id === undefined
        ? Prisma.empty
        : Prisma.sql`AND "id" = ${options.id}`;
    const rows = await this.prisma.$queryRaw<ClaimRow[]>`
      UPDATE "EmailJob" AS j
      SET "attemptToken" = ${lease},
          "attemptExpiresAt" = ${NOW_UTC} + ${LEASE},
          "attempts" = j."attempts" + 1,
          "lastAttemptAt" = ${NOW_UTC},
          "updatedAt" = ${NOW_UTC}
      FROM (
        SELECT "id" FROM "EmailJob"
        WHERE "status" = 'PENDING'
          AND "nextAttemptAt" <= ${NOW_UTC}
          AND ("attemptExpiresAt" IS NULL OR "attemptExpiresAt" < ${NOW_UTC})
          AND "attempts" < "maxAttempts"
          ${onlyId}
        ORDER BY "nextAttemptAt", "id"
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE j."id" = due."id"
      RETURNING j."id", j."type", j."recipient", j."orderId",
                j."idempotencyKey", j."attempts", j."maxAttempts",
                j."protectedPayload"`;

    return rows.map(({ protectedPayload, ...row }) => {
      const opened =
        protectedPayload === null
          ? null
          : this.box.open(protectedPayload, row.idempotencyKey);
      const secrets = opened === null ? null : parseSecrets(opened);
      return {
        ...row,
        lease,
        secrets,
        secretsUnreadable: protectedPayload !== null && secrets === null,
      };
    });
  }

  /** False when the lease was lost (the job was taken over or cancelled meanwhile). */
  async markSent(
    job: ClaimedEmailJob,
    providerMessageId: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.emailJob.updateMany({
      where: { id: job.id, attemptToken: job.lease, status: 'PENDING' },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId,
        protectedPayload: null,
        attemptToken: null,
        attemptExpiresAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    return count === 1;
  }

  /** Releases the job to be tried again at `nextAttemptAt`; secrets are kept. */
  async markRetry(
    job: ClaimedEmailJob,
    failure: SendFailure,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.emailJob.updateMany({
      where: { id: job.id, attemptToken: job.lease, status: 'PENDING' },
      data: {
        nextAttemptAt,
        attemptToken: null,
        attemptExpiresAt: null,
        failureCode: failure.code,
        failureMessage: failure.message,
      },
    });
    return count === 1;
  }

  /** Gives up on the job for good and erases its secrets. */
  async markFailed(
    job: ClaimedEmailJob,
    failure: SendFailure,
  ): Promise<boolean> {
    return this.finish(job, 'FAILED', failure.code, failure.message);
  }

  /** The email is no longer wanted (its order moved on). */
  async markCancelled(job: ClaimedEmailJob, code: string): Promise<boolean> {
    return this.finish(job, 'CANCELLED', code, null);
  }

  /**
   * Cancels an order's emails that are still to be sent, in the caller's
   * transaction (the one that confirms or expires the order). A worker sending
   * one at this moment loses its lease and records nothing.
   */
  async cancelForOrder(db: Db, orderId: string, code: string): Promise<number> {
    const { count } = await db.emailJob.updateMany({
      where: { orderId, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        protectedPayload: null,
        attemptToken: null,
        attemptExpiresAt: null,
        failureCode: code,
        failureMessage: null,
      },
    });
    return count;
  }

  /**
   * Fails jobs whose last allowed attempt never reported back (the worker died
   * mid-send and the lease ran out). They cannot be claimed again, so without
   * this they would stay pending, holding their secrets, for ever.
   */
  async reapAbandoned(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "EmailJob"
      SET "status" = 'FAILED', "protectedPayload" = NULL,
          "attemptToken" = NULL, "attemptExpiresAt" = NULL,
          "failureCode" = 'LEASE_EXPIRED',
          "failureMessage" = 'The last attempt did not report back',
          "updatedAt" = ${NOW_UTC}
      WHERE "status" = 'PENDING'
        AND "attempts" >= "maxAttempts"
        AND "attemptExpiresAt" < ${NOW_UTC}`;
  }

  private async finish(
    job: ClaimedEmailJob,
    status: 'FAILED' | 'CANCELLED',
    code: string,
    message: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.emailJob.updateMany({
      where: { id: job.id, attemptToken: job.lease, status: 'PENDING' },
      data: {
        status,
        protectedPayload: null,
        attemptToken: null,
        attemptExpiresAt: null,
        failureCode: code,
        failureMessage: message,
      },
    });
    return count === 1;
  }
}

function parseSecrets(json: string): Record<string, string> | null {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const entries = Object.entries(value);
    const secrets: Record<string, string> = {};
    for (const [key, entry] of entries) {
      if (typeof entry !== 'string') return null;
      secrets[key] = entry;
    }
    return secrets;
  } catch {
    return null;
  }
}
