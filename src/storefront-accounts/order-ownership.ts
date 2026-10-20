import { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';

const NOW_UTC = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);

/**
 * Gives an account the orders its address has confirmed and that belong to
 * nobody yet. This is the only linking rule there is: the order's recorded
 * confirmation address (immutable, proven by its emailed link) is the
 * account's address (immutable, proven by its setup link).
 *
 * What is never linked here: EXEMPT orders (placed before confirmation
 * existed, or by staff), whose email text proves nothing; orders still awaiting
 * confirmation, or expired; orders already owned. The Customer an order was
 * filed under plays no part, so several customer records (a legacy mixed-case
 * address, a different name) can end up with one account, and none of them,
 * nor any order snapshot, is changed. The database enforces the same rule (a
 * CHECK and a trigger), so this cannot link anything it should not.
 *
 * Idempotent and cheap when there is nothing to do: one UPDATE on the
 * `[confirmationEmail, confirmationStatus]` index that matches no row.
 */
export async function linkVerifiedOrders(
  db: Db,
  account: { id: string; email: string },
): Promise<number> {
  return db.$executeRaw`
    UPDATE "Order" SET "storefrontAccountId" = ${account.id},
      "updatedAt" = ${NOW_UTC}
    WHERE "confirmationEmail" = ${account.email}
      AND "confirmationStatus" = 'CONFIRMED'
      AND "storefrontAccountId" IS NULL`;
}
