import { EmailOutboxDispatcher } from '../src/email-outbox/email-outbox.dispatcher';
import { EmailOutboxStore } from '../src/email-outbox/email-outbox.store';
import { OrderConfirmationEmails } from '../src/email-outbox/order-confirmation-emails';
import { checkStorefrontToken } from '../src/storefront-tokens/storefront-tokens';
import {
  createCustomer,
  createOrder,
  createTestApp,
  resetDatabase,
  tokenFrom,
  type TestContext,
} from './helpers';

const HOUR_MS = 60 * 60 * 1000;

const transient = () =>
  Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' });
const permanent = () =>
  Object.assign(new Error('550 5.1.1 mailbox unavailable'), {
    responseCode: 550,
  });

/** The email outbox: recording, sending, retrying and claiming jobs. */
describe('Email outbox (e2e)', () => {
  let ctx: TestContext;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ctx.mail.clear();
  });

  const emails = () => ctx.app.get(OrderConfirmationEmails);
  const dispatcher = () => ctx.app.get(EmailOutboxDispatcher);
  const store = () => ctx.app.get(EmailOutboxStore);

  const awaitingOrder = async (expiresInMs = HOUR_MS) => {
    seq += 1;
    const email = `shopper${seq}@example.com`;
    return createOrder(
      ctx.prisma,
      await createCustomer(ctx.prisma, { email }),
      {
        status: 'PENDING',
        // Like every storefront order.
        paymentMethod: 'COD',
        confirmation: {
          status: 'AWAITING_CONFIRMATION',
          email,
          expiresAt: new Date(Date.now() + expiresInMs),
        },
      },
    );
  };

  const jobRow = (id: string) =>
    ctx.prisma.emailJob.findUniqueOrThrow({ where: { id } });
  const makeDue = (id: string) =>
    ctx.prisma.emailJob.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

  describe('recording', () => {
    it('records one job and one token per order, with the token sealed', async () => {
      const order = await awaitingOrder();
      const first = await emails().enqueue(ctx.prisma, order.id);
      const again = await emails().enqueue(ctx.prisma, order.id);

      expect(first.created).toBe(true);
      expect(again).toEqual({ jobId: first.jobId, created: false });
      await expect(ctx.prisma.emailJob.count()).resolves.toBe(1);
      await expect(
        ctx.prisma.storefrontToken.count({
          where: { orderId: order.id, purpose: 'ORDER_CONFIRMATION' },
        }),
      ).resolves.toBe(1);

      const job = await jobRow(first.jobId);
      expect(job).toMatchObject({
        type: 'ORDER_CONFIRMATION',
        status: 'PENDING',
        recipient: order.confirmationEmail,
        orderId: order.id,
        idempotencyKey: `order-confirmation:${order.id}`,
        attempts: 0,
      });
      expect(job.protectedPayload).toMatch(/^v1\./);
      expect(job.protectedPayload).not.toContain('oc_');
    });

    it("is part of the caller's transaction: a rollback leaves no job and no token", async () => {
      const order = await awaitingOrder();
      await expect(
        ctx.prisma.$transaction(async (tx) => {
          await emails().enqueue(tx, order.id);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await expect(ctx.prisma.emailJob.count()).resolves.toBe(0);
      await expect(ctx.prisma.storefrontToken.count()).resolves.toBe(0);
    });

    it('refuses an order that is not awaiting confirmation, or past its deadline', async () => {
      const exempt = await createOrder(
        ctx.prisma,
        await createCustomer(ctx.prisma),
      );
      await expect(emails().enqueue(ctx.prisma, exempt.id)).rejects.toThrow(
        /awaiting confirmation/,
      );
      const late = await awaitingOrder(-1000);
      await expect(emails().enqueue(ctx.prisma, late.id)).rejects.toThrow(
        /awaiting confirmation/,
      );
    });
  });

  describe('sending', () => {
    it('sends the order email once, with a working link, and erases the sealed token', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('sent');
      await expect(dispatcher().dispatchJob(jobId)).resolves.toBeNull();
      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        claimed: 0,
      });

      expect(ctx.mail.sent).toHaveLength(1);
      const [message] = ctx.mail.sent;
      expect(message.to).toBe(order.confirmationEmail);
      expect(message.subject).toBe(`Confirm your order ORD-${order.number}`);
      expect(message.idempotencyKey).toBe(jobId);
      expect(message.text).toContain(
        'http://localhost:3000/orders/confirm#token=oc_',
      );
      expect(message.text).toContain('Test Product x 1 at Rs 100.00');
      expect(message.text).toContain('Payment: cash on delivery');
      await expect(
        checkStorefrontToken(
          ctx.prisma,
          tokenFrom(message),
          'ORDER_CONFIRMATION',
        ),
      ).resolves.toMatchObject({
        status: 'valid',
        record: { orderId: order.id },
      });

      const job = await jobRow(jobId);
      expect(job).toMatchObject({
        status: 'SENT',
        attempts: 1,
        protectedPayload: null,
        attemptToken: null,
        attemptExpiresAt: null,
        providerMessageId: '<memory-1@test>',
      });
      expect(job.sentAt).toBeInstanceOf(Date);
    });

    it('retries a transient failure later with the same link and idempotency key', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      ctx.mail.failNext(transient());

      const before = Date.now();
      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('retrying');
      const waiting = await jobRow(jobId);
      expect(waiting).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        failureCode: 'ECONNRESET',
        failureMessage: 'Connection reset by peer',
        attemptToken: null,
      });
      expect(waiting.protectedPayload).not.toBeNull();
      expect(waiting.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        before + 60_000 - 1000,
      );
      // Not due yet: nobody may claim it.
      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        claimed: 0,
      });

      await makeDue(jobId);
      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        claimed: 1,
        sent: 1,
      });
      const [failed, retried] = ctx.mail.attempted;
      expect(ctx.mail.attempted).toHaveLength(2);
      expect(retried.text).toBe(failed.text);
      expect(retried.html).toBe(failed.html);
      expect(retried.idempotencyKey).toBe(jobId);
      expect(failed.idempotencyKey).toBe(jobId);
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'SENT',
        attempts: 2,
        failureCode: null,
        protectedPayload: null,
      });
    });

    it('gives up at once on a permanent refusal', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      ctx.mail.failNext(permanent());

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('failed');
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 1,
        failureCode: 'SMTP_550',
        protectedPayload: null,
      });
    });

    it('stops after the last allowed attempt', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      await ctx.prisma.emailJob.update({
        where: { id: jobId },
        data: { maxAttempts: 2 },
      });
      ctx.mail.failNext(transient(), 2);

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('retrying');
      await makeDue(jobId);
      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('failed');
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'FAILED',
        attempts: 2,
        protectedPayload: null,
      });
      await makeDue(jobId).catch(() => undefined);
      await expect(dispatcher().dispatchJob(jobId)).resolves.toBeNull();
      expect(ctx.mail.sent).toHaveLength(0);
    });

    it('does not schedule a retry the order would no longer accept', async () => {
      const order = await awaitingOrder(30_000);
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      ctx.mail.failNext(transient());

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('failed');
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'ECONNRESET',
      });
    });

    it('cancels instead of sending once the order has moved on', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      await ctx.prisma.order.update({
        where: { id: order.id },
        data: { confirmationStatus: 'CONFIRMED', confirmedAt: new Date() },
      });

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('cancelled');
      expect(ctx.mail.attempted).toHaveLength(0);
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'CANCELLED',
        failureCode: 'ORDER_NOT_AWAITING',
        protectedPayload: null,
      });
    });

    it('fails a job whose sealed token cannot be read, without sending', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      await ctx.prisma.emailJob.update({
        where: { id: jobId },
        data: {
          protectedPayload: 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA',
        },
      });

      await expect(dispatcher().dispatchJob(jobId)).resolves.toBe('failed');
      expect(ctx.mail.attempted).toHaveLength(0);
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'PAYLOAD_UNREADABLE',
        protectedPayload: null,
      });
    });
  });

  describe('claims', () => {
    it('lets concurrent workers send every job exactly once', async () => {
      const jobIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const order = await awaitingOrder();
        jobIds.push((await emails().enqueue(ctx.prisma, order.id)).jobId);
      }
      ctx.mail.delayMs = 30;

      const results = await Promise.all([
        dispatcher().dispatchDue(),
        dispatcher().dispatchDue(),
        dispatcher().dispatchDue(),
      ]);
      expect(results.reduce((sum, r) => sum + r.claimed, 0)).toBe(6);
      expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(6);
      expect(ctx.mail.attempted).toHaveLength(6);
      expect(new Set(ctx.mail.sent.map((m) => m.idempotencyKey))).toEqual(
        new Set(jobIds),
      );
      const jobs = await ctx.prisma.emailJob.findMany();
      expect(
        jobs.every((job) => job.status === 'SENT' && job.attempts === 1),
      ).toBe(true);
    });

    it('takes over a job whose worker died, once its lease runs out', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      const [dead] = await store().claim({ limit: 1, id: jobId });
      expect(dead.lease).toBeDefined();

      // The lease is live: nobody else may take the job.
      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        claimed: 0,
      });
      await ctx.prisma.emailJob.update({
        where: { id: jobId },
        data: { attemptExpiresAt: new Date(Date.now() - 1000) },
      });
      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        claimed: 1,
        sent: 1,
      });
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'SENT',
        attempts: 2,
      });
      // The dead worker's late report changes nothing.
      await expect(store().markSent(dead, null)).resolves.toBe(false);
    });

    it('fails a job whose last attempt never reported back', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      await ctx.prisma.emailJob.update({
        where: { id: jobId },
        data: { maxAttempts: 1 },
      });
      await store().claim({ limit: 1, id: jobId });
      await ctx.prisma.emailJob.update({
        where: { id: jobId },
        data: { attemptExpiresAt: new Date(Date.now() - 1000) },
      });

      await expect(dispatcher().dispatchDue()).resolves.toMatchObject({
        abandoned: 1,
        claimed: 0,
      });
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'FAILED',
        failureCode: 'LEASE_EXPIRED',
        protectedPayload: null,
        attemptToken: null,
      });
    });

    it("cancels an order's pending emails, even one being sent right now", async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);
      const [sending] = await store().claim({ limit: 1, id: jobId });

      await expect(
        ctx.prisma.$transaction((tx) =>
          store().cancelForOrder(tx, order.id, 'ORDER_CONFIRMED'),
        ),
      ).resolves.toBe(1);
      await expect(store().markSent(sending, '<late@test>')).resolves.toBe(
        false,
      );
      await expect(jobRow(jobId)).resolves.toMatchObject({
        status: 'CANCELLED',
        failureCode: 'ORDER_CONFIRMED',
        protectedPayload: null,
        attemptToken: null,
        providerMessageId: null,
      });
    });
  });

  describe('durability', () => {
    it('leaves pending work for a fresh process to send', async () => {
      const order = await awaitingOrder();
      const { jobId } = await emails().enqueue(ctx.prisma, order.id);

      // A new application instance, as after a restart, knows nothing but the database.
      const restarted = await createTestApp();
      try {
        await expect(
          restarted.app.get(EmailOutboxDispatcher).dispatchDue(),
        ).resolves.toMatchObject({ claimed: 1, sent: 1 });
        expect(restarted.mail.sent).toHaveLength(1);
        expect(restarted.mail.sent[0].idempotencyKey).toBe(jobId);
      } finally {
        await restarted.close();
      }
      expect(ctx.mail.sent).toHaveLength(0);
    });

    it('finishes a send started after commit before the app shuts down', async () => {
      const other = await createTestApp();
      const order = await awaitingOrder();
      const { jobId } = await other.app
        .get(OrderConfirmationEmails)
        .enqueue(other.prisma, order.id);
      other.mail.delayMs = 100;

      other.app.get(EmailOutboxDispatcher).dispatchAfterCommit(jobId);
      await other.close();

      expect(other.mail.sent).toHaveLength(1);
      await expect(jobRow(jobId)).resolves.toMatchObject({ status: 'SENT' });
    });
  });
});
