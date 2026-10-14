import type {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../generated/prisma/client';
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
const METHODS: (PaymentMethod | null)[] = [null, 'COD'];

/** An order without a payment method: legacy or unspecified. */
const LEGACY = null;

const movesFor = (
  paymentStatus: PaymentStatus,
  paymentMethod: PaymentMethod | null,
): [OrderStatus, OrderStatus][] => {
  const allowed: [OrderStatus, OrderStatus][] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      // Staying where it is is not a move, so it is not listed either.
      if (
        from !== to &&
        describeInvalidTransition(from, to, paymentStatus, paymentMethod) ===
          null
      ) {
        allowed.push([from, to]);
      }
    }
  }
  return allowed;
};

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

  it.each(METHODS)(
    'allows exactly these moves for a paid order (method %s)',
    (method) => {
      expect(movesFor('PAID', method)).toEqual([
        ['PENDING', 'PROCESSING'],
        ['PENDING', 'SHIPPED'],
        ['PENDING', 'CANCELLED'],
        ['PROCESSING', 'SHIPPED'],
        ['PROCESSING', 'CANCELLED'],
        ['SHIPPED', 'DELIVERED'],
      ]);
    },
  );

  describe('an order without a payment method', () => {
    it('refuses to ship or deliver it until it has been paid', () => {
      for (const payment of ['PENDING', 'REFUNDED'] as const) {
        expect(
          describeInvalidTransition('PENDING', 'SHIPPED', payment, LEGACY),
        ).toBe('An order can only be marked as shipped once it has been paid.');
        expect(
          describeInvalidTransition('PROCESSING', 'SHIPPED', payment, LEGACY),
        ).toBe('An order can only be marked as shipped once it has been paid.');
        expect(
          describeInvalidTransition('SHIPPED', 'DELIVERED', payment, LEGACY),
        ).toBe(
          'An order can only be marked as delivered once it has been paid.',
        );
      }
    });

    it('lets it be processed or cancelled while unpaid', () => {
      expect(movesFor('PENDING', LEGACY)).toEqual([
        ['PENDING', 'PROCESSING'],
        ['PENDING', 'CANCELLED'],
        ['PROCESSING', 'CANCELLED'],
      ]);
    });
  });

  describe('a cash-on-delivery order', () => {
    it('may be processed, shipped or cancelled while its payment is pending', () => {
      expect(movesFor('PENDING', 'COD')).toEqual([
        ['PENDING', 'PROCESSING'],
        ['PENDING', 'SHIPPED'],
        ['PENDING', 'CANCELLED'],
        ['PROCESSING', 'SHIPPED'],
        ['PROCESSING', 'CANCELLED'],
      ]);
    });

    it('may not be delivered until the cash has been recorded as paid', () => {
      expect(
        describeInvalidTransition('SHIPPED', 'DELIVERED', 'PENDING', 'COD'),
      ).toBe(
        'Record the cash payment before marking a cash-on-delivery order as delivered.',
      );
      expect(
        describeInvalidTransition('SHIPPED', 'DELIVERED', 'PAID', 'COD'),
      ).toBeNull();
    });

    it('is never shipped or delivered with a refunded payment', () => {
      for (const to of ['SHIPPED', 'DELIVERED'] as const) {
        expect(
          describeInvalidTransition(
            to === 'SHIPPED' ? 'PROCESSING' : 'SHIPPED',
            to,
            'REFUNDED',
            'COD',
          ),
        ).not.toBeNull();
      }
    });

    it('still cannot be cancelled once it has been shipped', () => {
      for (const payment of PAYMENTS) {
        expect(
          describeInvalidTransition('SHIPPED', 'CANCELLED', payment, 'COD'),
        ).toBe("A shipped order can't be cancelled.");
      }
    });
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
  ] as const)(
    'explains why %s cannot become %s, whatever the payment',
    (from, to, message) => {
      for (const payment of PAYMENTS) {
        for (const method of METHODS) {
          expect(describeInvalidTransition(from, to, payment, method)).toBe(
            message,
          );
        }
      }
    },
  );
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
