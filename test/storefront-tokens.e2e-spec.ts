import { sha256 } from '../src/common/crypto.util';
import {
  checkStorefrontToken,
  consumeStorefrontToken,
  createStorefrontToken,
  issueStorefrontToken,
  storefrontTokenHash,
  voidStorefrontTokens,
} from '../src/storefront-tokens/storefront-tokens';
import {
  createCustomer,
  createOrder,
  createTestApp,
  resetDatabase,
  type TestContext,
} from './helpers';

const HOUR_MS = 60 * 60 * 1000;

/** Issuing, checking and using storefront tokens against the database. */
describe('Storefront tokens (e2e)', () => {
  let ctx: TestContext;
  let orderId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const order = await createOrder(
      ctx.prisma,
      await createCustomer(ctx.prisma),
      {
        status: 'PENDING',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      },
    );
    orderId = order.id;
  });

  const issue = (
    purpose: 'ORDER_CONFIRMATION' | 'ACCOUNT_SETUP' = 'ORDER_CONFIRMATION',
  ) =>
    issueStorefrontToken(ctx.prisma, {
      purpose,
      orderId,
      email: 'ada@example.com',
      expiresAt: new Date(Date.now() + HOUR_MS),
    });

  /** A token that ran out an hour ago (written directly, as time cannot be moved). */
  const expiredToken = async () => {
    const token = createStorefrontToken('ORDER_CONFIRMATION');
    await ctx.prisma.storefrontToken.create({
      data: {
        purpose: 'ORDER_CONFIRMATION',
        tokenHash: storefrontTokenHash(token, 'ORDER_CONFIRMATION')!,
        orderId,
        email: 'ada@example.com',
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
        expiresAt: new Date(Date.now() - HOUR_MS),
      },
    });
    return token;
  };

  it('stores only the hash of the token it returns', async () => {
    const { token, id } = await issue();
    const row = await ctx.prisma.storefrontToken.findUniqueOrThrow({
      where: { id },
    });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('accepts a live token for its own purpose only', async () => {
    const { token } = await issue('ORDER_CONFIRMATION');
    await expect(
      checkStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({
      status: 'valid',
      record: { orderId, email: 'ada@example.com', usedAt: null },
    });
    await expect(
      checkStorefrontToken(ctx.prisma, token, 'ACCOUNT_SETUP'),
    ).resolves.toEqual({ status: 'invalid' });
    await expect(
      consumeStorefrontToken(ctx.prisma, token, 'ACCOUNT_SETUP'),
    ).resolves.toEqual({ status: 'invalid' });

    // Even a row whose hash matches is not found under another purpose.
    const setup = await issue('ACCOUNT_SETUP');
    await expect(
      checkStorefrontToken(ctx.prisma, setup.token, 'ACCOUNT_SETUP'),
    ).resolves.toMatchObject({ status: 'valid' });
    await expect(
      checkStorefrontToken(ctx.prisma, setup.token, 'ORDER_CONFIRMATION'),
    ).resolves.toEqual({ status: 'invalid' });
  });

  it('refuses unknown and malformed tokens alike', async () => {
    for (const token of [
      createStorefrontToken('ORDER_CONFIRMATION'),
      'oc_short',
      '',
      null,
      42,
    ]) {
      await expect(
        checkStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
      ).resolves.toEqual({ status: 'invalid' });
      await expect(
        consumeStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
      ).resolves.toEqual({ status: 'invalid' });
    }
  });

  it('reports an expired token as expired and never uses it', async () => {
    const token = await expiredToken();
    await expect(
      checkStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({ status: 'expired' });
    await expect(
      consumeStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({ status: 'expired', record: { usedAt: null } });
  });

  it('is used once; afterwards it reports as used', async () => {
    const { token } = await issue();
    const first = await consumeStorefrontToken(
      ctx.prisma,
      token,
      'ORDER_CONFIRMATION',
    );
    expect(first.status).toBe('consumed');
    await expect(
      consumeStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({ status: 'used' });
    await expect(
      checkStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({ status: 'used' });
  });

  it('lets exactly one of many concurrent attempts use it', async () => {
    const { token } = await issue();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
      ),
    );
    expect(results.filter((r) => r.status === 'consumed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'used')).toHaveLength(5);
  });

  it('takes part in the caller transaction: a rollback undoes issuing and using', async () => {
    let issued = '';
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        issued = (
          await issueStorefrontToken(tx, {
            purpose: 'ORDER_CONFIRMATION',
            orderId,
            email: 'ada@example.com',
            expiresAt: new Date(Date.now() + HOUR_MS),
          })
        ).token;
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await expect(
      checkStorefrontToken(ctx.prisma, issued, 'ORDER_CONFIRMATION'),
    ).resolves.toEqual({ status: 'invalid' });

    const { token } = await issue();
    await expect(
      ctx.prisma.$transaction(async (tx) => {
        const used = await consumeStorefrontToken(
          tx,
          token,
          'ORDER_CONFIRMATION',
        );
        expect(used.status).toBe('consumed');
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await expect(
      checkStorefrontToken(ctx.prisma, token, 'ORDER_CONFIRMATION'),
    ).resolves.toMatchObject({ status: 'valid' });
  });

  it("voids an order's unused tokens of one purpose, keeping the one asked for", async () => {
    const older = await issue('ACCOUNT_SETUP');
    const newer = await issue('ACCOUNT_SETUP');
    const confirmation = await issue('ORDER_CONFIRMATION');

    await expect(
      voidStorefrontTokens(ctx.prisma, {
        purpose: 'ACCOUNT_SETUP',
        orderId,
        exceptId: newer.id,
      }),
    ).resolves.toBe(1);
    await expect(
      checkStorefrontToken(ctx.prisma, older.token, 'ACCOUNT_SETUP'),
    ).resolves.toMatchObject({ status: 'used' });
    await expect(
      checkStorefrontToken(ctx.prisma, newer.token, 'ACCOUNT_SETUP'),
    ).resolves.toMatchObject({ status: 'valid' });
    await expect(
      checkStorefrontToken(
        ctx.prisma,
        confirmation.token,
        'ORDER_CONFIRMATION',
      ),
    ).resolves.toMatchObject({ status: 'valid' });
    await expect(
      voidStorefrontTokens(ctx.prisma, { purpose: 'ACCOUNT_SETUP' }),
    ).rejects.toThrow(/an order, an account or an email/);
  });

  it('refuses to record a token for another purpose than its prefix says', async () => {
    await expect(
      issueStorefrontToken(ctx.prisma, {
        purpose: 'ACCOUNT_SETUP',
        orderId,
        email: 'ada@example.com',
        expiresAt: new Date(Date.now() + HOUR_MS),
        token: createStorefrontToken('ORDER_CONFIRMATION'),
      }),
    ).rejects.toThrow(/Not a token for ACCOUNT_SETUP/);
  });
});
