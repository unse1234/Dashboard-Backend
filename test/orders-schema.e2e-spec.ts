import type {
  OrderStatus,
  PaymentStatus,
} from '../src/generated/prisma/client';
import {
  createCustomer,
  createOrder,
  createTestApp,
  createUser,
  resetDatabase,
  type TestContext,
} from './helpers';

/** The database rules the order lifecycle migration adds. */
describe('Order lifecycle schema (e2e)', () => {
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

  describe('status and payment status', () => {
    const allowed: [OrderStatus, PaymentStatus][] = [
      ['PENDING', 'PENDING'],
      ['PENDING', 'PAID'],
      ['PROCESSING', 'PENDING'],
      ['PROCESSING', 'PAID'],
      ['SHIPPED', 'PAID'],
      ['DELIVERED', 'PAID'],
      ['CANCELLED', 'PENDING'],
      ['CANCELLED', 'REFUNDED'],
    ];
    const refused: [OrderStatus, PaymentStatus][] = [
      ['PENDING', 'REFUNDED'],
      ['PROCESSING', 'REFUNDED'],
      ['SHIPPED', 'PENDING'],
      ['SHIPPED', 'REFUNDED'],
      ['DELIVERED', 'PENDING'],
      ['DELIVERED', 'REFUNDED'],
      ['CANCELLED', 'PAID'],
    ];

    it.each(allowed)('accepts %s with payment %s', async (status, payment) => {
      const customer = await createCustomer(ctx.prisma);
      await expect(
        createOrder(ctx.prisma, customer, { status, paymentStatus: payment }),
      ).resolves.toBeDefined();
    });

    it.each(refused)('refuses %s with payment %s', async (status, payment) => {
      const customer = await createCustomer(ctx.prisma);
      await expect(
        createOrder(ctx.prisma, customer, { status, paymentStatus: payment }),
      ).rejects.toThrow(/Order_payment_consistency_check/);
    });

    it('refuses an update that would break the rule', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer, {
        status: 'PENDING',
        paymentStatus: 'PENDING',
      });
      await expect(
        ctx.prisma.order.update({
          where: { id: order.id },
          data: { status: 'DELIVERED' },
        }),
      ).rejects.toThrow(/Order_payment_consistency_check/);
    });
  });

  describe('cash on delivery', () => {
    it('lets a COD order ship while its payment is still pending', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer, {
        status: 'SHIPPED',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
      });
      expect(order.paymentMethod).toBe('COD');
    });

    it('still refuses to ship an order with no payment method unpaid', async () => {
      // A NULL method must not turn the COD branch into NULL, which a CHECK lets through.
      const customer = await createCustomer(ctx.prisma);
      await expect(
        createOrder(ctx.prisma, customer, {
          status: 'SHIPPED',
          paymentStatus: 'PENDING',
          paymentMethod: null,
        }),
      ).rejects.toThrow(/Order_payment_consistency_check/);
    });

    it('still requires a COD order to be paid before it is delivered', async () => {
      const customer = await createCustomer(ctx.prisma);
      await expect(
        createOrder(ctx.prisma, customer, {
          status: 'DELIVERED',
          paymentStatus: 'PENDING',
          paymentMethod: 'COD',
        }),
      ).rejects.toThrow(/Order_payment_consistency_check/);
    });

    it('refuses a shipped COD order that is refunded or never paid for', async () => {
      const customer = await createCustomer(ctx.prisma);
      await expect(
        createOrder(ctx.prisma, customer, {
          status: 'SHIPPED',
          paymentStatus: 'REFUNDED',
          paymentMethod: 'COD',
        }),
      ).rejects.toThrow(/Order_payment_consistency_check/);
    });

    it('accepts the payment being collected after it shipped', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer, {
        status: 'SHIPPED',
        paymentStatus: 'PENDING',
        paymentMethod: 'COD',
      });
      const paid = await ctx.prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'PAID' },
      });
      expect(paid.paymentStatus).toBe('PAID');
    });

    it('leaves the payment method empty unless one is given', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      expect(order.paymentMethod).toBeNull();
    });

    it('accepts only a known payment method', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      await expect(
        ctx.prisma
          .$executeRaw`UPDATE "Order" SET "paymentMethod" = 'CARD' WHERE "id" = ${order.id}`,
      ).rejects.toThrow();
    });
  });

  describe('currency', () => {
    it('is PKR unless a historical fixture says otherwise', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      expect(order.currency).toBe('PKR');
    });

    it('can be PKR', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer, {
        currency: 'PKR',
      });
      expect(order.currency).toBe('PKR');
    });

    it('cannot be an unknown currency', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      await expect(
        ctx.prisma
          .$executeRaw`UPDATE "Order" SET "currency" = 'EUR' WHERE "id" = ${order.id}`,
      ).rejects.toThrow();
    });
  });

  describe('idempotency keys', () => {
    it('are unique, and an order may have none', async () => {
      const customer = await createCustomer(ctx.prisma);
      const a = await createOrder(ctx.prisma, customer);
      const b = await createOrder(ctx.prisma, customer);
      await ctx.prisma.order.update({
        where: { id: a.id },
        data: { idempotencyKey: 'key-0000001', requestHash: 'x' },
      });

      await expect(
        ctx.prisma.order.update({
          where: { id: b.id },
          data: { idempotencyKey: 'key-0000001', requestHash: 'x' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      // Two orders without a key do not clash.
      expect(
        await ctx.prisma.order.count({ where: { idempotencyKey: null } }),
      ).toBe(1);
    });
  });

  describe('counts and positions', () => {
    it('rejects a negative item count', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      await expect(
        ctx.prisma.order.update({
          where: { id: order.id },
          data: { itemCount: -1 },
        }),
      ).rejects.toThrow(/Order_item_count_check/);
    });

    it('rejects a negative line position', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      const [line] = await ctx.prisma.orderItem.findMany({
        where: { orderId: order.id },
      });
      await expect(
        ctx.prisma.orderItem.update({
          where: { id: line.id },
          data: { position: -1 },
        }),
      ).rejects.toThrow(/OrderItem_position_check/);
    });

    it('records the units of an order created through the fixture', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      expect(order.itemCount).toBe(1);
    });
  });

  describe('the history of an order', () => {
    it('goes with the order', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      await ctx.prisma.orderEvent.create({
        data: { orderId: order.id, type: 'CREATED', toStatus: 'PENDING' },
      });
      await ctx.prisma.order.delete({ where: { id: order.id } });
      expect(await ctx.prisma.orderEvent.count()).toBe(0);
    });

    it('survives the removal of the person who made the change', async () => {
      const customer = await createCustomer(ctx.prisma);
      const order = await createOrder(ctx.prisma, customer);
      const user = await createUser(ctx.prisma);
      await ctx.prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'STATUS_CHANGED',
          fromStatus: 'PENDING',
          toStatus: 'PROCESSING',
          actorId: user.id,
        },
      });
      await ctx.prisma.user.delete({ where: { id: user.id } });
      const [event] = await ctx.prisma.orderEvent.findMany();
      expect(event.actorId).toBeNull();
    });
  });
});
