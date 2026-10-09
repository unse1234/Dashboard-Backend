import {
  createAddress,
  createCustomer,
  createOrder,
  createTestApp,
  resetDatabase,
  type TestContext,
} from './helpers';

/** The database rules the migration adds on top of what Prisma models. */
describe('Customers and orders schema (e2e)', () => {
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

  const orderData = (customerId: string) => ({
    customerId,
    customerName: 'Ada',
    customerEmail: 'ada@example.com',
    shippingAddress: {},
    billingAddress: {},
  });

  it('numbers customers and orders from 1001 and 10001 upwards', async () => {
    const customer = await createCustomer(ctx.prisma);
    const order = await createOrder(ctx.prisma, customer);
    expect(customer.number).toBeGreaterThanOrEqual(1001);
    expect(order.number).toBeGreaterThanOrEqual(10001);
  });

  it('rejects an order whose total is not subtotal + shipping - discount + tax', async () => {
    const customer = await createCustomer(ctx.prisma);
    await expect(
      ctx.prisma.order.create({
        data: {
          ...orderData(customer.id),
          subtotal: '100.00',
          shipping: '5.00',
          discount: '10.00',
          tax: '8.00',
          total: '104.00',
        },
      }),
    ).rejects.toThrow(/Order_total_check/);

    await expect(
      ctx.prisma.order.create({
        data: {
          ...orderData(customer.id),
          subtotal: '100.00',
          shipping: '5.00',
          discount: '10.00',
          tax: '8.00',
          total: '103.00',
        },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects negative amounts on an order', async () => {
    const customer = await createCustomer(ctx.prisma);
    await expect(
      ctx.prisma.order.create({
        data: {
          ...orderData(customer.id),
          subtotal: '10.00',
          shipping: '0.00',
          discount: '-5.00',
          tax: '0.00',
          total: '15.00',
        },
      }),
    ).rejects.toThrow(/Order_amounts_non_negative_check/);
  });

  it('rejects order lines with a non-positive quantity or a wrong total', async () => {
    const customer = await createCustomer(ctx.prisma);
    const order = await createOrder(ctx.prisma, customer);
    const line = {
      orderId: order.id,
      productId: 'PRD-1',
      productName: 'Mug',
      sku: 'MUG',
    };

    await expect(
      ctx.prisma.orderItem.create({
        data: { ...line, quantity: 0, unitPrice: '5.00', total: '0.00' },
      }),
    ).rejects.toThrow(/OrderItem_amounts_check/);
    await expect(
      ctx.prisma.orderItem.create({
        data: { ...line, quantity: 3, unitPrice: '5.00', total: '14.99' },
      }),
    ).rejects.toThrow(/OrderItem_amounts_check/);
    await expect(
      ctx.prisma.orderItem.create({
        data: { ...line, quantity: 3, unitPrice: '5.05', total: '15.15' },
      }),
    ).resolves.toBeDefined();
  });

  it('allows one default address per customer and type', async () => {
    const customer = await createCustomer(ctx.prisma);
    await createAddress(ctx.prisma, customer.id, {
      type: 'SHIPPING',
      isDefault: true,
    });

    // Another default of the other type, and any number of non-defaults, are fine.
    await createAddress(ctx.prisma, customer.id, {
      type: 'BILLING',
      isDefault: true,
    });
    await createAddress(ctx.prisma, customer.id, { type: 'SHIPPING' });
    await createAddress(ctx.prisma, customer.id, { type: 'SHIPPING' });

    await expect(
      createAddress(ctx.prisma, customer.id, {
        type: 'SHIPPING',
        isDefault: true,
      }),
    ).rejects.toThrow();

    // The rule is per customer.
    const other = await createCustomer(ctx.prisma);
    await expect(
      createAddress(ctx.prisma, other.id, {
        type: 'SHIPPING',
        isDefault: true,
      }),
    ).resolves.toBeDefined();
  });

  it('keeps a customer who has orders from being deleted', async () => {
    const customer = await createCustomer(ctx.prisma);
    await createOrder(ctx.prisma, customer);
    await expect(
      ctx.prisma.customer.delete({ where: { id: customer.id } }),
    ).rejects.toThrow();
    expect(await ctx.prisma.customer.count()).toBe(1);
  });

  it("deletes a customer's addresses with the customer", async () => {
    const customer = await createCustomer(ctx.prisma);
    await createAddress(ctx.prisma, customer.id);
    await ctx.prisma.customer.delete({ where: { id: customer.id } });
    expect(await ctx.prisma.customerAddress.count()).toBe(0);
  });

  it("deletes an order's lines with the order", async () => {
    const customer = await createCustomer(ctx.prisma);
    const order = await createOrder(ctx.prisma, customer);
    expect(await ctx.prisma.orderItem.count()).toBe(1);
    await ctx.prisma.order.delete({ where: { id: order.id } });
    expect(await ctx.prisma.orderItem.count()).toBe(0);
  });

  it('keeps the customer snapshot on an order when the customer changes', async () => {
    const customer = await createCustomer(ctx.prisma, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    const order = await createOrder(ctx.prisma, customer);
    await ctx.prisma.customer.update({
      where: { id: customer.id },
      data: { name: 'Ada King', email: 'ada.king@example.com' },
    });
    const reread = await ctx.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(reread.customerName).toBe('Ada Lovelace');
    expect(reread.customerEmail).toBe('ada@example.com');
  });
});
