import { Prisma } from '../../generated/prisma/client';
import type { OrderDetailRow } from '../order.mapper';
import { toStorefrontReceipt } from './storefront-order.mapper';
import { guestRequestHash } from './storefront-orders.service';

const request = {
  contact: {
    name: 'Ayesha Khan',
    email: 'a@example.com',
    phone: '03001234567',
  },
  lines: [
    { number: 1001, quantity: 2 },
    { number: 1002, quantity: 1 },
  ],
  shippingAddress: { city: 'Lahore', country: 'PK' },
  quoteToken: 'token-1',
};

describe('guestRequestHash', () => {
  it('is the same request however the lines are listed', () => {
    expect(
      guestRequestHash({ ...request, lines: [...request.lines].reverse() }),
    ).toBe(guestRequestHash(request));
  });

  it.each([
    [
      'a quantity',
      { lines: [{ number: 1001, quantity: 3 }, request.lines[1]] },
    ],
    ['the email', { contact: { ...request.contact, email: 'b@example.com' } }],
    ['the phone', { contact: { ...request.contact, phone: '03007654321' } }],
    ['the address', { shippingAddress: { city: 'Karachi', country: 'PK' } }],
    ['the quote', { quoteToken: 'token-2' }],
  ])('differs when %s differs', (_name, change) => {
    expect(guestRequestHash({ ...request, ...change })).not.toBe(
      guestRequestHash(request),
    );
  });
});

describe('toStorefrontReceipt', () => {
  const row = {
    id: 'internal-uuid',
    number: 1042,
    customer: { number: 77 },
    customerName: 'Ayesha Khan',
    customerEmail: 'a@example.com',
    customerPhone: '03001234567',
    status: 'PENDING',
    paymentStatus: 'PENDING',
    paymentMethod: 'COD',
    currency: 'PKR',
    itemCount: 2,
    subtotal: new Prisma.Decimal('3000.00'),
    shipping: new Prisma.Decimal('0'),
    discount: new Prisma.Decimal('0'),
    tax: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('3000.00'),
    shippingAddress: { city: 'Lahore' },
    billingAddress: { city: 'Lahore' },
    createdAt: new Date('2026-10-14T08:00:00.000Z'),
    updatedAt: new Date('2026-10-14T08:00:00.000Z'),
    items: [
      {
        id: 'item-uuid',
        productId: 'PRD-1001',
        productName: 'Kettle',
        sku: 'KET-1',
        quantity: 2,
        unitPrice: new Prisma.Decimal('1500.00'),
        total: new Prisma.Decimal('3000.00'),
      },
    ],
  } as unknown as OrderDetailRow;

  it('carries the reference, status, method, currency and amounts', () => {
    expect(toStorefrontReceipt(row)).toEqual({
      id: 'ORD-1042',
      createdAt: '2026-10-14T08:00:00.000Z',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      paymentMethod: 'COD',
      currency: 'PKR',
      items: [
        {
          productId: 'PRD-1001',
          productName: 'Kettle',
          quantity: 2,
          unitPrice: 1500,
          total: 3000,
        },
      ],
      subtotal: 3000,
      shipping: 0,
      tax: 0,
      discount: 0,
      total: 3000,
    });
  });

  it('leaves out the customer, internal ids, SKUs and addresses', () => {
    const raw = JSON.stringify(toStorefrontReceipt(row));
    for (const hidden of [
      'internal-uuid',
      'item-uuid',
      'KET-1',
      'a@example.com',
      'Ayesha',
      '03001234567',
      'CUS-',
      'Lahore',
    ]) {
      expect(raw).not.toContain(hidden);
    }
  });
});
