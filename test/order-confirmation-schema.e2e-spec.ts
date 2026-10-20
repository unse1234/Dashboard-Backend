import type {
  OrderConfirmationStatus,
  OrderStatus,
  PaymentStatus,
} from '../src/generated/prisma/client';
import {
  createCustomer,
  createOrder,
  createTestApp,
  resetDatabase,
  type OrderOptions,
  type TestContext,
} from './helpers';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The database rules the order confirmation and storefront account migration
 * adds. Nothing uses these tables yet; this pins down what they accept.
 */
describe('Order confirmation and storefront account schema (e2e)', () => {
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

  const orderWith = async (options: OrderOptions = {}) =>
    createOrder(ctx.prisma, await createCustomer(ctx.prisma), options);

  const createAccount = (email = 'ada@example.com') =>
    ctx.prisma.storefrontAccount.create({
      data: { email, passwordHash: 'argon2-hash', emailVerifiedAt: new Date() },
    });

  describe('order confirmation state', () => {
    it('records an order as EXEMPT, unconfirmed and unowned by default', async () => {
      const order = await orderWith();
      expect(order).toMatchObject({
        confirmationStatus: 'EXEMPT',
        confirmationEmail: null,
        confirmationExpiresAt: null,
        confirmedAt: null,
        storefrontAccountId: null,
      });
    });

    const deadline = () => new Date(Date.now() + HOUR_MS);
    type Case = [
      string,
      OrderStatus,
      PaymentStatus,
      NonNullable<OrderOptions['confirmation']>,
    ];

    const allowed: Case[] = [
      [
        'awaiting, pending and unpaid',
        'PENDING',
        'PENDING',
        {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: deadline(),
        },
      ],
      [
        'confirmed, then worked on as usual',
        'PROCESSING',
        'PAID',
        {
          status: 'CONFIRMED',
          email: 'ada@example.com',
          expiresAt: deadline(),
          confirmedAt: new Date(),
        },
      ],
      [
        'expired and cancelled',
        'CANCELLED',
        'PENDING',
        {
          status: 'EXPIRED',
          email: 'ada@example.com',
          expiresAt: new Date(Date.now() - HOUR_MS),
        },
      ],
    ];

    const refused: Case[] = [
      [
        'exempt with an address',
        'PENDING',
        'PENDING',
        { status: 'EXEMPT', email: 'ada@example.com' },
      ],
      [
        'exempt but marked confirmed',
        'DELIVERED',
        'PAID',
        { status: 'EXEMPT', confirmedAt: new Date() },
      ],
      [
        'awaiting without a deadline',
        'PENDING',
        'PENDING',
        { status: 'AWAITING_CONFIRMATION', email: 'ada@example.com' },
      ],
      [
        'awaiting without an address',
        'PENDING',
        'PENDING',
        { status: 'AWAITING_CONFIRMATION', expiresAt: deadline() },
      ],
      [
        'awaiting but already processing',
        'PROCESSING',
        'PENDING',
        {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: deadline(),
        },
      ],
      [
        'awaiting but paid',
        'PENDING',
        'PAID',
        {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: deadline(),
        },
      ],
      [
        'awaiting with a confirmation time',
        'PENDING',
        'PENDING',
        {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: deadline(),
          confirmedAt: new Date(),
        },
      ],
      [
        'confirmed without a confirmation time',
        'PENDING',
        'PENDING',
        {
          status: 'CONFIRMED',
          email: 'ada@example.com',
          expiresAt: deadline(),
        },
      ],
      [
        'confirmed after its deadline',
        'PENDING',
        'PENDING',
        {
          status: 'CONFIRMED',
          email: 'ada@example.com',
          expiresAt: new Date(Date.now() - HOUR_MS),
          confirmedAt: new Date(),
        },
      ],
      [
        'expired but not cancelled',
        'PENDING',
        'PENDING',
        {
          status: 'EXPIRED',
          email: 'ada@example.com',
          expiresAt: new Date(Date.now() - HOUR_MS),
        },
      ],
    ];

    it.each(allowed)(
      'accepts an order %s',
      async (_, status, paymentStatus, confirmation) => {
        await expect(
          orderWith({ status, paymentStatus, confirmation }),
        ).resolves.toMatchObject({ confirmationStatus: confirmation.status });
      },
    );

    it.each(refused)(
      'refuses an order %s',
      async (_, status, paymentStatus, confirmation) => {
        await expect(
          orderWith({ status, paymentStatus, confirmation }),
        ).rejects.toThrow(/Order_confirmation_state_check/);
      },
    );

    it.each(['Ada@example.com', ' ada@example.com', ''])(
      'refuses the confirmation address %j',
      async (email) => {
        await expect(
          orderWith({
            status: 'PENDING',
            confirmation: {
              status: 'AWAITING_CONFIRMATION',
              email,
              expiresAt: deadline(),
            },
          }),
        ).rejects.toThrow(/Order_confirmation_email_check/);
      },
    );

    const awaiting = () =>
      orderWith({
        status: 'PENDING',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email: 'ada@example.com',
          expiresAt: deadline(),
        },
      });

    it('lets an awaiting order be confirmed, or expire as a cancellation', async () => {
      const toConfirm = await awaiting();
      await expect(
        ctx.prisma.order.update({
          where: { id: toConfirm.id },
          data: { confirmationStatus: 'CONFIRMED', confirmedAt: new Date() },
        }),
      ).resolves.toMatchObject({ confirmationStatus: 'CONFIRMED' });

      const toExpire = await awaiting();
      await expect(
        ctx.prisma.order.update({
          where: { id: toExpire.id },
          data: { confirmationStatus: 'EXPIRED' },
        }),
      ).rejects.toThrow(/Order_confirmation_state_check/);
      await expect(
        ctx.prisma.order.update({
          where: { id: toExpire.id },
          data: { confirmationStatus: 'EXPIRED', status: 'CANCELLED' },
        }),
      ).resolves.toMatchObject({ confirmationStatus: 'EXPIRED' });
    });

    it('never lets the confirmation address change, nor an exempt order gain one', async () => {
      const order = await awaiting();
      await expect(
        ctx.prisma.order.update({
          where: { id: order.id },
          data: { confirmationEmail: 'eve@example.com' },
        }),
      ).rejects.toThrow(/confirmationEmail cannot change/);
      await expect(
        ctx.prisma.order.update({
          where: { id: order.id },
          data: { confirmationEmail: 'ada@example.com' },
        }),
      ).resolves.toBeDefined();

      const exempt = await orderWith({ status: 'PENDING' });
      const becomes: OrderConfirmationStatus[] = [
        'AWAITING_CONFIRMATION',
        'CONFIRMED',
      ];
      for (const confirmationStatus of becomes) {
        await expect(
          ctx.prisma.order.update({
            where: { id: exempt.id },
            data: {
              confirmationStatus,
              confirmationEmail: 'ada@example.com',
              confirmationExpiresAt: deadline(),
            },
          }),
        ).rejects.toThrow(/confirmationEmail cannot change/);
      }
    });

    it('leaves existing orders processable along their usual lifecycle', async () => {
      const order = await orderWith({ status: 'PENDING' });
      for (const status of ['PROCESSING', 'CANCELLED'] as const) {
        await expect(
          ctx.prisma.order.update({
            where: { id: order.id },
            data: { status },
          }),
        ).resolves.toMatchObject({ status, confirmationStatus: 'EXEMPT' });
      }
    });
  });

  describe('order ownership', () => {
    it('gives an order that needed confirmation to an account, and lists it by account', async () => {
      const account = await createAccount();
      const order = await orderWith({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        confirmation: {
          status: 'CONFIRMED',
          email: account.email,
          expiresAt: new Date(Date.now() + HOUR_MS),
          confirmedAt: new Date(),
          storefrontAccountId: account.id,
        },
      });
      const owned = await ctx.prisma.order.findMany({
        where: { storefrontAccountId: account.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(owned).toEqual([{ id: order.id }]);
    });

    it('never gives an exempt order to an account', async () => {
      const account = await createAccount();
      const order = await orderWith();
      await expect(
        ctx.prisma.order.update({
          where: { id: order.id },
          data: { storefrontAccountId: account.id },
        }),
      ).rejects.toThrow(/Order_storefront_account_check/);
    });

    it('keeps the order, as a guest order, when its account is deleted', async () => {
      const account = await createAccount();
      // Owned orders are confirmed ones (20261020100000_storefront_order_ownership).
      const order = await orderWith({
        status: 'PENDING',
        confirmation: {
          status: 'CONFIRMED',
          email: account.email,
          expiresAt: new Date(Date.now() + HOUR_MS),
          confirmedAt: new Date(),
          storefrontAccountId: account.id,
        },
      });
      await ctx.prisma.storefrontAccount.delete({ where: { id: account.id } });
      await expect(
        ctx.prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      ).resolves.toMatchObject({ storefrontAccountId: null });
    });
  });

  describe('storefront accounts and sessions', () => {
    it('allows one account per address', async () => {
      await createAccount('ada@example.com');
      await expect(createAccount('ada@example.com')).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it.each(['Ada@example.com', 'ada@example.com ', ''])(
      'refuses the address %j',
      async (email) => {
        await expect(createAccount(email)).rejects.toThrow(
          /StorefrontAccount_email_check/,
        );
      },
    );

    it('refuses an empty password hash', async () => {
      await expect(
        ctx.prisma.storefrontAccount.create({
          data: {
            email: 'ada@example.com',
            passwordHash: '',
            emailVerifiedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/StorefrontAccount_password_hash_check/);
    });

    it('removes sessions with their account', async () => {
      const account = await createAccount();
      await ctx.prisma.storefrontSession.create({
        data: {
          accountId: account.id,
          refreshTokenHash: 'hash',
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });
      await ctx.prisma.storefrontAccount.delete({ where: { id: account.id } });
      await expect(ctx.prisma.storefrontSession.count()).resolves.toBe(0);
    });
  });

  describe('storefront tokens', () => {
    const tokenFor = (
      orderId: string,
      data: { tokenHash?: string; email?: string; expiresAt?: Date } = {},
    ) =>
      ctx.prisma.storefrontToken.create({
        data: {
          purpose: 'ORDER_CONFIRMATION',
          orderId,
          tokenHash: data.tokenHash ?? 'hash-1',
          email: data.email ?? 'ada@example.com',
          expiresAt: data.expiresAt ?? new Date(Date.now() + HOUR_MS),
        },
      });

    it('is found by its hash, which is unique', async () => {
      const order = await orderWith();
      const token = await tokenFor(order.id);
      await expect(
        ctx.prisma.storefrontToken.findUnique({
          where: { tokenHash: 'hash-1' },
          select: { id: true, purpose: true, usedAt: true },
        }),
      ).resolves.toEqual({
        id: token.id,
        purpose: 'ORDER_CONFIRMATION',
        usedAt: null,
      });
      await expect(tokenFor(order.id)).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('refuses a mixed-case address and an expiry that is not in the future', async () => {
      const order = await orderWith();
      await expect(
        tokenFor(order.id, { email: 'Ada@example.com' }),
      ).rejects.toThrow(/StorefrontToken_email_check/);
      await expect(
        tokenFor(order.id, { expiresAt: new Date(Date.now() - 1000) }),
      ).rejects.toThrow(/StorefrontToken_expiry_check/);
    });
  });

  describe('email jobs', () => {
    const jobFor = (
      orderId: string | null,
      data: Partial<{
        idempotencyKey: string;
        recipient: string;
        status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
        attempts: number;
        sentAt: Date;
        attemptToken: string;
        attemptExpiresAt: Date;
      }> = {},
    ) =>
      ctx.prisma.emailJob.create({
        data: {
          type: 'ORDER_CONFIRMATION',
          orderId,
          recipient: 'ada@example.com',
          idempotencyKey: 'order-confirmation:1',
          ...data,
        },
      });

    it('starts pending, due now, with no attempts, and is recorded once per key', async () => {
      const order = await orderWith();
      const job = await jobFor(order.id);
      expect(job).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 5,
        attemptToken: null,
        sentAt: null,
      });
      expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      await expect(jobFor(order.id)).rejects.toMatchObject({ code: 'P2002' });
    });

    it('needs an order for an order confirmation', async () => {
      await expect(jobFor(null)).rejects.toThrow(/EmailJob_order_check/);
    });

    it('refuses a mixed-case recipient and attempts beyond the maximum', async () => {
      const order = await orderWith();
      await expect(
        jobFor(order.id, { recipient: 'Ada@example.com' }),
      ).rejects.toThrow(/EmailJob_recipient_check/);
      await expect(jobFor(order.id, { attempts: 6 })).rejects.toThrow(
        /EmailJob_attempts_check/,
      );
    });

    it('is sent exactly when it has a sent time, and holds a lease only while pending', async () => {
      const order = await orderWith();
      const lease = {
        attemptToken: 'lease',
        attemptExpiresAt: new Date(Date.now() + 60_000),
      };
      const refusals = [
        { status: 'SENT' as const },
        { sentAt: new Date() },
        { attemptToken: 'lease' },
        { status: 'SENT' as const, sentAt: new Date(), ...lease },
        { status: 'FAILED' as const, ...lease },
      ];
      for (const [index, data] of refusals.entries()) {
        await expect(
          jobFor(order.id, { idempotencyKey: `refused:${index}`, ...data }),
        ).rejects.toThrow(/EmailJob_state_check/);
      }
      await expect(
        jobFor(order.id, { idempotencyKey: 'leased', ...lease }),
      ).resolves.toBeDefined();
      await expect(
        jobFor(order.id, {
          idempotencyKey: 'sent',
          status: 'SENT',
          sentAt: new Date(),
        }),
      ).resolves.toBeDefined();
    });
  });
});
