import { Prisma } from '../../generated/prisma/client';
import type { OrderDetailRow } from '../order.mapper';
import {
  confirmationStateOf,
  toConfirmationPreview,
  toConfirmationRequired,
  toConfirmationResult,
  toStorefrontReceipt,
} from './storefront-order.mapper';
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

  it('is unchanged by the confirmation columns', () => {
    const receipt = toStorefrontReceipt({
      ...row,
      confirmationStatus: 'AWAITING_CONFIRMATION',
      confirmationEmail: 'a@example.com',
      confirmationExpiresAt: new Date('2026-10-14T09:00:00.000Z'),
    });
    expect(Object.keys(receipt).sort()).toEqual([
      'createdAt',
      'currency',
      'discount',
      'id',
      'items',
      'paymentMethod',
      'paymentStatus',
      'shipping',
      'status',
      'subtotal',
      'tax',
      'total',
    ]);
  });
});

describe('toConfirmationRequired', () => {
  const deadline = new Date('2026-10-14T09:00:00.000Z');
  const awaiting = {
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
    itemCount: 1,
    subtotal: new Prisma.Decimal('1500.00'),
    shipping: new Prisma.Decimal('0'),
    discount: new Prisma.Decimal('0'),
    tax: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('1500.00'),
    shippingAddress: { city: 'Lahore' },
    billingAddress: { city: 'Lahore' },
    confirmationStatus: 'AWAITING_CONFIRMATION',
    confirmationEmail: 'a@example.com',
    confirmationExpiresAt: deadline,
    createdAt: new Date('2026-10-14T08:00:00.000Z'),
    updatedAt: new Date('2026-10-14T08:00:00.000Z'),
    items: [
      {
        id: 'item-uuid',
        productId: 'PRD-1001',
        productName: 'Kettle',
        sku: 'KET-1',
        quantity: 1,
        unitPrice: new Prisma.Decimal('1500.00'),
        total: new Prisma.Decimal('1500.00'),
      },
    ],
  } as unknown as OrderDetailRow;
  const before = new Date('2026-10-14T08:30:00.000Z');

  it('says where the link went, until when, and what was ordered', () => {
    expect(toConfirmationRequired(awaiting, 'cr_x', before)).toEqual({
      outcome: 'CONFIRMATION_REQUIRED',
      confirmation: {
        status: 'AWAITING_CONFIRMATION',
        email: 'a@example.com',
        expiresAt: '2026-10-14T09:00:00.000Z',
        receiptToken: 'cr_x',
      },
      order: {
        currency: 'PKR',
        paymentMethod: 'COD',
        items: [
          {
            productId: 'PRD-1001',
            productName: 'Kettle',
            quantity: 1,
            unitPrice: 1500,
            total: 1500,
          },
        ],
        subtotal: 1500,
        shipping: 0,
        tax: 0,
        discount: 0,
        total: 1500,
      },
    });
  });

  it('carries no order reference, address, contact detail, SKU or internal id', () => {
    const raw = JSON.stringify(toConfirmationRequired(awaiting, null, before));
    for (const hidden of [
      'ORD-',
      'internal-uuid',
      'item-uuid',
      'KET-1',
      'Ayesha',
      '03001234567',
      'CUS-',
      'Lahore',
    ]) {
      expect(raw).not.toContain(hidden);
    }
  });

  it('reports an order past its deadline as expired, before any job has run', () => {
    expect(
      toConfirmationRequired(awaiting, null, deadline).confirmation.status,
    ).toBe('EXPIRED');
    expect(
      toConfirmationRequired(
        { ...awaiting, confirmationStatus: 'CONFIRMED' },
        null,
        deadline,
      ).confirmation.status,
    ).toBe('CONFIRMED');
  });

  it('refuses an order that never needed confirmation', () => {
    expect(() =>
      toConfirmationRequired(
        {
          ...awaiting,
          confirmationStatus: 'EXEMPT',
          confirmationEmail: null,
          confirmationExpiresAt: null,
        },
        null,
      ),
    ).toThrow(/did not need confirmation/);
  });
});

describe('confirmation preview and result', () => {
  const deadline = new Date('2026-10-14T09:00:00.000Z');
  const before = new Date('2026-10-14T08:30:00.000Z');
  const row = (
    overrides: Partial<Record<string, unknown>> = {},
  ): OrderDetailRow =>
    ({
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
      itemCount: 1,
      subtotal: new Prisma.Decimal('1500.00'),
      shipping: new Prisma.Decimal('0'),
      discount: new Prisma.Decimal('0'),
      tax: new Prisma.Decimal('0'),
      total: new Prisma.Decimal('1500.00'),
      shippingAddress: {
        recipientName: 'Ayesha Khan',
        phone: '03001234567',
        addressLine1: 'House 12, Street 4',
        addressLine2: null,
        city: 'Lahore',
        region: 'Punjab',
        postalCode: '54000',
        country: 'PK',
      },
      billingAddress: {},
      confirmationStatus: 'AWAITING_CONFIRMATION',
      confirmationEmail: 'a@example.com',
      confirmationExpiresAt: deadline,
      createdAt: new Date('2026-10-14T08:00:00.000Z'),
      updatedAt: new Date('2026-10-14T08:00:00.000Z'),
      items: [
        {
          id: 'item-uuid',
          productId: 'PRD-1001',
          productName: 'Kettle',
          sku: 'KET-1',
          quantity: 1,
          unitPrice: new Prisma.Decimal('1500.00'),
          total: new Prisma.Decimal('1500.00'),
        },
      ],
      ...overrides,
    }) as unknown as OrderDetailRow;

  it('tells an order past its deadline from one still waiting', () => {
    expect(confirmationStateOf(row(), before)).toBe('AWAITING_CONFIRMATION');
    expect(confirmationStateOf(row(), deadline)).toBe('EXPIRED');
    expect(
      confirmationStateOf(row({ confirmationStatus: 'CONFIRMED' }), deadline),
    ).toBe('CONFIRMED');
    expect(
      confirmationStateOf(
        row({ confirmationStatus: 'EXEMPT', confirmationExpiresAt: null }),
      ),
    ).toBeNull();
  });

  it('previews what is being confirmed: amounts and roughly where, nothing more', () => {
    const preview = toConfirmationPreview(row(), false, before);
    expect(preview).toEqual({
      status: 'AWAITING_CONFIRMATION',
      expiresAt: '2026-10-14T09:00:00.000Z',
      order: expect.objectContaining({ total: 1500, currency: 'PKR' }),
      delivery: {
        recipientName: 'Ayesha Khan',
        city: 'Lahore',
        region: 'Punjab',
        country: 'PK',
      },
    });
    const raw = JSON.stringify(preview);
    for (const hidden of [
      'ORD-',
      'House 12',
      '03001234567',
      'a@example.com',
      'KET-1',
      'internal-uuid',
    ]) {
      expect(raw).not.toContain(hidden);
    }
  });

  it('previews only the state of an order that can no longer be confirmed, or a replaced link', () => {
    expect(toConfirmationPreview(row(), false, deadline)).toEqual({
      status: 'EXPIRED',
    });
    expect(
      toConfirmationPreview(row({ confirmationStatus: 'CONFIRMED' }), false),
    ).toEqual({ status: 'CONFIRMED' });
    expect(toConfirmationPreview(row(), true, before)).toEqual({
      status: 'LINK_REPLACED',
    });
  });

  it('answers a confirmation with the receipt, the delivery details and the account offer', () => {
    const result = toConfirmationResult(
      row({ confirmationStatus: 'CONFIRMED' }),
      false,
      { kind: 'SIGN_IN' },
    );
    expect(result).toMatchObject({
      outcome: 'CONFIRMED',
      alreadyConfirmed: false,
      order: { id: 'ORD-1042', total: 1500 },
      delivery: {
        contactName: 'Ayesha Khan',
        email: 'a@example.com',
        address: { city: 'Lahore', addressLine1: 'House 12, Street 4' },
      },
      account: { kind: 'SIGN_IN' },
    });
    const raw = JSON.stringify(result);
    for (const hidden of ['internal-uuid', 'item-uuid', 'KET-1', 'CUS-']) {
      expect(raw).not.toContain(hidden);
    }
  });
});
