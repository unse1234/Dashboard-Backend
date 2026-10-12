import type { OrderStatus, PaymentStatus } from '../generated/prisma/client';
import {
  describeInvalidTransition,
  ORDER_TRANSITIONS,
  paymentStatusAfter,
} from './order-lifecycle';

const STATUSES: OrderStatus[] = [
  'PENDING',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
];
const PAYMENTS: PaymentStatus[] = ['PENDING', 'PAID', 'REFUNDED'];

describe('the order lifecycle', () => {
  it('has a rule for every status', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
  });

  it('only ever moves forward', () => {
    const rank = Object.fromEntries(
      STATUSES.map((status, index) => [status, index]),
    ) as Record<OrderStatus, number>;
    for (const from of STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) {
        // Cancelling is the one move to "before" DELIVERED in the list order.
        if (to !== 'CANCELLED') {
          expect(rank[to]).toBeGreaterThan(rank[from]);
        }
      }
    }
  });

  it('treats delivered and cancelled orders as final', () => {
    expect(ORDER_TRANSITIONS.DELIVERED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('allows exactly these moves for an order that has been paid', () => {
    const allowed: [OrderStatus, OrderStatus][] = [];
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (describeInvalidTransition(from, to, 'PAID') === null) {
          allowed.push([from, to]);
        }
      }
    }
    // Staying where it is is not a move, so it is not listed either.
    expect(allowed.filter(([from, to]) => from !== to)).toEqual([
      ['PENDING', 'PROCESSING'],
      ['PENDING', 'SHIPPED'],
      ['PENDING', 'CANCELLED'],
      ['PROCESSING', 'SHIPPED'],
      ['PROCESSING', 'CANCELLED'],
      ['SHIPPED', 'DELIVERED'],
    ]);
  });

  it('refuses to ship or deliver an order that has not been paid', () => {
    for (const payment of ['PENDING', 'REFUNDED'] as const) {
      expect(describeInvalidTransition('PENDING', 'SHIPPED', payment)).toBe(
        'An order can only be marked as shipped once it has been paid.',
      );
      expect(describeInvalidTransition('PROCESSING', 'SHIPPED', payment)).toBe(
        'An order can only be marked as shipped once it has been paid.',
      );
    }
  });

  it('lets an unpaid order be processed or cancelled', () => {
    expect(describeInvalidTransition('PENDING', 'PROCESSING', 'PENDING')).toBe(
      null,
    );
    expect(describeInvalidTransition('PENDING', 'CANCELLED', 'PENDING')).toBe(
      null,
    );
    expect(
      describeInvalidTransition('PROCESSING', 'CANCELLED', 'PENDING'),
    ).toBe(null);
  });

  it.each([
    ['DELIVERED', 'SHIPPED', "A delivered order can't change status."],
    ['DELIVERED', 'CANCELLED', "A delivered order can't change status."],
    ['CANCELLED', 'PENDING', "A cancelled order can't change status."],
    ['CANCELLED', 'SHIPPED', "A cancelled order can't change status."],
    ['SHIPPED', 'CANCELLED', "A shipped order can't be cancelled."],
    ['SHIPPED', 'PROCESSING', "An order can't go from shipped to processing."],
    ['SHIPPED', 'PENDING', "An order can't go from shipped to pending."],
    ['PROCESSING', 'PENDING', "An order can't go from processing to pending."],
    ['PENDING', 'DELIVERED', "An order can't go from pending to delivered."],
    [
      'PROCESSING',
      'DELIVERED',
      "An order can't go from processing to delivered.",
    ],
  ] as const)('explains why %s cannot become %s', (from, to, message) => {
    for (const payment of PAYMENTS) {
      expect(describeInvalidTransition(from, to, payment)).toBe(message);
    }
  });
});

describe('paymentStatusAfter', () => {
  it('records a cancelled paid order as refunded', () => {
    expect(paymentStatusAfter('CANCELLED', 'PAID')).toBe('REFUNDED');
  });

  it('leaves an unpaid cancelled order unpaid', () => {
    expect(paymentStatusAfter('CANCELLED', 'PENDING')).toBe('PENDING');
  });

  it.each(['PROCESSING', 'SHIPPED', 'DELIVERED'] as const)(
    'does not touch the payment when the order becomes %s',
    (to) => {
      expect(paymentStatusAfter(to, 'PAID')).toBe('PAID');
      expect(paymentStatusAfter(to, 'PENDING')).toBe('PENDING');
    },
  );
});
