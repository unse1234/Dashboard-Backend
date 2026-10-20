import { randomUUID } from 'node:crypto';
import { issueStorefrontToken } from '../src/storefront-tokens/storefront-tokens';
import { purgeExpiredRecords } from '../src/storefront-tokens/retention';
import {
  createCustomer,
  createOrder,
  createTestApp,
  resetDatabase,
  type TestContext,
} from './helpers';

jest.setTimeout(60_000);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The scheduled run's purge (plan 8.8): only what can no longer matter. */
describe('Retention purge (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  it('deletes old tokens, finished jobs and ended sessions, and nothing still in use', async () => {
    const db = ctx.prisma;
    const email = 'ayesha@example.com';
    const customer = await createCustomer(db, { email });
    const now = Date.now();
    const order = await createOrder(db, customer, {
      status: 'PENDING',
      confirmation: {
        status: 'CONFIRMED',
        email,
        expiresAt: new Date(now + DAY_MS),
        confirmedAt: new Date(now),
      },
    });

    const token = async (expiresInMs: number) => {
      const issued = await issueStorefrontToken(db, {
        purpose: 'CHECKOUT_RECEIPT',
        orderId: order.id,
        email,
        expiresAt: new Date(now + 60_000),
      });
      await db.storefrontToken.update({
        where: { id: issued.id },
        data: {
          createdAt: new Date(now + expiresInMs - 60_000),
          expiresAt: new Date(now + expiresInMs),
        },
      });
      return issued.id;
    };
    const longExpired = await token(-2 * DAY_MS);
    const justExpired = await token(-60_000);
    const live = await token(DAY_MS);

    const job = (
      status: 'SENT' | 'FAILED' | 'CANCELLED' | 'PENDING',
      ageMs: number,
    ) =>
      db.emailJob.create({
        data: {
          type: 'ORDER_CONFIRMATION',
          status,
          recipient: email,
          orderId: order.id,
          idempotencyKey: randomUUID(),
          sentAt: status === 'SENT' ? new Date(now - ageMs) : null,
          updatedAt: new Date(now - ageMs),
        },
      });
    const oldSent = await job('SENT', 31 * DAY_MS);
    const oldFailed = await job('FAILED', 31 * DAY_MS);
    const recentSent = await job('SENT', DAY_MS);
    const oldPending = await job('PENDING', 31 * DAY_MS);
    // updatedAt is set by Prisma on write; put the old ones back in the past.
    for (const [id, ageMs] of [
      [oldSent.id, 31 * DAY_MS],
      [oldFailed.id, 31 * DAY_MS],
      [oldPending.id, 31 * DAY_MS],
    ] as const) {
      await db.$executeRaw`UPDATE "EmailJob" SET "updatedAt" = ${new Date(now - ageMs)} WHERE "id" = ${id}`;
    }

    const account = await db.storefrontAccount.create({
      data: { email, passwordHash: 'argon2-hash', emailVerifiedAt: new Date() },
    });
    const session = (data: { expiresAt: Date; revokedAt?: Date }) =>
      db.storefrontSession.create({
        data: {
          accountId: account.id,
          refreshTokenHash: randomUUID(),
          ...data,
        },
      });
    const oldRevoked = await session({
      expiresAt: new Date(now + DAY_MS),
      revokedAt: new Date(now - 31 * DAY_MS),
    });
    const oldExpired = await session({
      expiresAt: new Date(now - 31 * DAY_MS),
    });
    const liveSession = await session({ expiresAt: new Date(now + DAY_MS) });

    await expect(purgeExpiredRecords(db)).resolves.toEqual({
      tokens: 1,
      emailJobs: 2,
      sessions: 2,
    });

    const ids = async <T extends { id: string }>(rows: Promise<T[]>) =>
      (await rows).map((row) => row.id).sort();
    expect(await ids(db.storefrontToken.findMany())).toEqual(
      [justExpired, live].sort(),
    );
    expect(longExpired).toBeDefined();
    expect(await ids(db.emailJob.findMany())).toEqual(
      [recentSent.id, oldPending.id].sort(),
    );
    expect(await ids(db.storefrontSession.findMany())).toEqual([
      liveSession.id,
    ]);
    expect(oldRevoked.id).not.toBe(oldExpired.id);
    // Orders are never purged.
    expect(await db.order.count()).toBe(1);
    // A second run finds nothing more.
    await expect(purgeExpiredRecords(db)).resolves.toEqual({
      tokens: 0,
      emailJobs: 0,
      sessions: 0,
    });
  });
});
