import { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';

/** Rows removed per table per run, so one run stays short with a backlog. */
export const PURGE_BATCH = 1000;

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);

export interface PurgeSummary {
  tokens: number;
  emailJobs: number;
  sessions: number;
}

/**
 * Deletes what has stopped mattering (plan 8.8), a bounded batch each:
 * - storefront tokens a day past their expiry, used or not (every kind: link,
 *   receipt, setup, reset; a token is useless once expired);
 * - email jobs that finished (sent, failed, cancelled) 30 days ago; a pending
 *   job is never touched;
 * - storefront sessions that ended (revoked or expired) 30 days ago.
 *
 * Orders are never purged: an expired order stays as a cancelled record.
 * Safe to run alongside everything else: it only deletes rows nothing can use.
 */
export async function purgeExpiredRecords(db: Db): Promise<PurgeSummary> {
  const tokens = await db.$executeRaw`
    DELETE FROM "StorefrontToken" WHERE "id" IN (
      SELECT "id" FROM "StorefrontToken"
      WHERE "expiresAt" < ${NOW_UTC} - interval '1 day'
      LIMIT ${PURGE_BATCH})`;
  const emailJobs = await db.$executeRaw`
    DELETE FROM "EmailJob" WHERE "id" IN (
      SELECT "id" FROM "EmailJob"
      WHERE "status" IN ('SENT', 'FAILED', 'CANCELLED')
        AND "updatedAt" < ${NOW_UTC} - interval '30 days'
      LIMIT ${PURGE_BATCH})`;
  const sessions = await db.$executeRaw`
    DELETE FROM "StorefrontSession" WHERE "id" IN (
      SELECT "id" FROM "StorefrontSession"
      WHERE ("revokedAt" IS NOT NULL AND "revokedAt" < ${NOW_UTC} - interval '30 days')
         OR "expiresAt" < ${NOW_UTC} - interval '30 days'
      LIMIT ${PURGE_BATCH})`;
  return { tokens, emailJobs, sessions };
}
