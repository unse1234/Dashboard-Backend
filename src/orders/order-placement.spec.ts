import type { Db } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { placeOrder, type PlaceOrderInput } from './order-placement';

describe('PKR order placement', () => {
  it('refuses a legacy currency observed during stock deduction, before writing an order', async () => {
    const create = jest.fn();
    const tx = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'product',
            number: 1001,
            status: 'ACTIVE',
            archivedAt: null,
            currency: 'PKR',
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'product',
          number: 1001,
          name: 'Mug',
          sku: 'MUG',
          price: '100.00',
          currency: 'USD',
          stock: 9,
        },
      ]),
      order: { create },
    } as unknown as Db;
    const input: PlaceOrderInput = {
      customer: {
        id: 'customer',
        name: 'Buyer',
        email: 'buyer@example.com',
        phone: null,
      },
      lines: [{ number: 1001, quantity: 1 }],
      adjustments: {
        shipping: new Prisma.Decimal(0),
        discount: new Prisma.Decimal(0),
        tax: new Prisma.Decimal(0),
      },
      paymentStatus: 'PENDING',
      paymentMethod: null,
      shippingAddress: {},
      billingAddress: {},
      actorId: null,
      key: 'pkr-order',
      requestHash: 'hash',
    };
    await expect(placeOrder(tx, input)).rejects.toMatchObject({
      failure: { kind: 'PRODUCT_UNAVAILABLE', productNumber: 1001 },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
