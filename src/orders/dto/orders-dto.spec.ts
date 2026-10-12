import { ValidationPipe } from '@nestjs/common';
import { CreateOrderDto } from './create-order.dto';
import { ListOrdersQueryDto } from './list-orders-query.dto';
import {
  UpdateOrderStatusDto,
  UpdatePaymentStatusDto,
} from './update-order-status.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const query = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: ListOrdersQueryDto });
const create = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CreateOrderDto });
const status = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: UpdateOrderStatusDto });
const payment = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: UpdatePaymentStatusDto });

const address = {
  recipientName: 'Ada Lovelace',
  addressLine1: '12 St James Square',
  city: 'London',
  country: 'United Kingdom',
};
const valid = {
  customerId: 'CUS-1001',
  items: [{ productId: 'PRD-1001', quantity: 2 }],
  shippingAddress: address,
};

describe('ListOrdersQueryDto', () => {
  it('defaults to the first page of 20, ascending when a sort is given', async () => {
    await expect(query({})).resolves.toEqual({
      page: 1,
      pageSize: 20,
      sortOrder: 'asc',
    });
  });

  it('converts query strings and trims the search', async () => {
    await expect(
      query({
        page: '2',
        pageSize: '50',
        search: '  ada  ',
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        customerId: 'CUS-1001',
        sortBy: 'itemCount',
        sortOrder: 'desc',
      }),
    ).resolves.toEqual({
      page: 2,
      pageSize: 50,
      search: 'ada',
      status: 'SHIPPED',
      paymentStatus: 'PAID',
      customerId: 'CUS-1001',
      sortBy: 'itemCount',
      sortOrder: 'desc',
    });
  });

  it.each([
    'id',
    'customer',
    'createdAt',
    'itemCount',
    'total',
    'paymentStatus',
    'status',
  ])('accepts sortBy=%s', async (sortBy) => {
    await expect(query({ sortBy })).resolves.toMatchObject({ sortBy });
  });

  it.each([
    ['page 0', { page: '0' }],
    ['pageSize over 100', { pageSize: '101' }],
    ['an unknown status', { status: 'SENT' }],
    ['a status in the wrong case', { status: 'shipped' }],
    ['an unknown payment status', { paymentStatus: 'OWED' }],
    ['a customer id without its prefix', { customerId: '1001' }],
    ['another kind of id', { customerId: 'ORD-1001' }],
    ['an unknown sort column', { sortBy: 'customerName' }],
    ['an unknown sort order', { sortOrder: 'up' }],
    ['a search over 100 characters', { search: 'a'.repeat(101) }],
    ['an unknown parameter', { from: '2026-01-01' }],
  ])('rejects %s', async (_label, value) => {
    await expect(query(value)).rejects.toMatchObject({ status: 400 });
  });
});

describe('CreateOrderDto', () => {
  it('accepts the required fields alone', async () => {
    await expect(create(valid)).resolves.toMatchObject({
      customerId: 'CUS-1001',
      items: [{ productId: 'PRD-1001', quantity: 2 }],
    });
  });

  it('accepts every optional field', async () => {
    await expect(
      create({
        ...valid,
        shipping: 4.99,
        discount: 1,
        tax: 5.1,
        paymentStatus: 'PAID',
        billingAddress: { ...address, phone: '+44 20 7946 0000', region: null },
      }),
    ).resolves.toMatchObject({
      shipping: 4.99,
      discount: 1,
      tax: 5.1,
      paymentStatus: 'PAID',
    });
  });

  it('trims the address and turns blank optional parts into null', async () => {
    const dto = (await create({
      ...valid,
      shippingAddress: {
        ...address,
        recipientName: '  Ada Lovelace  ',
        addressLine2: '   ',
        phone: '',
      },
    })) as CreateOrderDto;

    expect(dto.shippingAddress).toMatchObject({
      recipientName: 'Ada Lovelace',
      addressLine2: null,
      phone: null,
    });
  });

  it('accepts the limits of lines, quantity and amounts', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      productId: `PRD-${1001 + i}`,
      quantity: 1000,
    }));
    await expect(
      create({ ...valid, items, shipping: 1_000_000, discount: 0, tax: 0 }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['no customer', { customerId: undefined }],
    ['a customer that is not an id', { customerId: 'ada@example.com' }],
    ['no items', { items: [] }],
    ['no item list', { items: undefined }],
    [
      'too many items',
      {
        items: Array.from({ length: 101 }, (_, i) => ({
          productId: `PRD-${i + 1}`,
          quantity: 1,
        })),
      },
    ],
    ['an item that is not an object', { items: ['PRD-1001'] }],
    ['an item without a product', { items: [{ quantity: 1 }] }],
    [
      'a product that is not an id',
      { items: [{ productId: '1001', quantity: 1 }] },
    ],
    ['a quantity of 0', { items: [{ productId: 'PRD-1', quantity: 0 }] }],
    ['a negative quantity', { items: [{ productId: 'PRD-1', quantity: -1 }] }],
    [
      'a fractional quantity',
      { items: [{ productId: 'PRD-1', quantity: 1.5 }] },
    ],
    [
      'a quantity over 1000',
      { items: [{ productId: 'PRD-1', quantity: 1001 }] },
    ],
    [
      'a price on a line',
      { items: [{ productId: 'PRD-1', quantity: 1, unitPrice: 1 }] },
    ],
    ['a negative shipping amount', { shipping: -0.01 }],
    ['an amount over 1,000,000', { tax: 1_000_000.01 }],
    ['an amount with three decimals', { discount: 1.005 }],
    ['an amount sent as text', { shipping: '4.99' }],
    ['a null amount', { shipping: null }],
    ['a payment status that is not allowed', { paymentStatus: 'REFUNDED' }],
    ['a null payment status', { paymentStatus: null }],
    ['no shipping address', { shippingAddress: undefined }],
    ['a null shipping address', { shippingAddress: null }],
    ['a shipping address that is not an object', { shippingAddress: 'London' }],
    [
      'an address without a city',
      { shippingAddress: { ...address, city: '' } },
    ],
    [
      'an address without a recipient',
      { shippingAddress: { ...address, recipientName: '   ' } },
    ],
    [
      'an address with an unknown field',
      { shippingAddress: { ...address, planet: 'Mars' } },
    ],
    ['a null billing address', { billingAddress: null }],
    ['a status', { status: 'SHIPPED' }],
    ['a total', { total: 0.01 }],
    ['a subtotal', { subtotal: 0.01 }],
    ['an idempotency key', { idempotencyKey: 'abcdefghij' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(create({ ...valid, ...overrides })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('UpdateOrderStatusDto', () => {
  it.each(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
    'accepts %s',
    async (value) => {
      await expect(status({ status: value })).resolves.toEqual({
        status: value,
      });
    },
  );

  it.each([
    ['a missing status', {}],
    ['a lower-case status', { status: 'shipped' }],
    ['an unknown status', { status: 'SENT' }],
    ['a null status', { status: null }],
    ['an extra field', { status: 'SHIPPED', paymentStatus: 'PAID' }],
  ])('rejects %s', async (_label, value) => {
    await expect(status(value)).rejects.toMatchObject({ status: 400 });
  });
});

describe('UpdatePaymentStatusDto', () => {
  it('accepts only "PAID"', async () => {
    await expect(payment({ paymentStatus: 'PAID' })).resolves.toEqual({
      paymentStatus: 'PAID',
    });
    for (const value of ['PENDING', 'REFUNDED', 'paid', null, undefined]) {
      await expect(payment({ paymentStatus: value })).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
