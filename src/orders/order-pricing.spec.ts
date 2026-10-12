import { Prisma } from '../generated/prisma/client';
import { exceedsOrderValue, priceOrder } from './order-pricing';

const d = (value: string | number) => new Prisma.Decimal(value);
const none = { shipping: d(0), discount: d(0), tax: d(0) };

describe('priceOrder', () => {
  it('sums the lines and adds shipping and tax, less the discount', () => {
    const price = priceOrder(
      [
        { unitPrice: d('249.00'), quantity: 1 },
        { unitPrice: d('39.95'), quantity: 2 },
      ],
      { shipping: d('7.99'), discount: d('32.89'), tax: d('26.30') },
    );

    expect(price.lineTotals.map((t) => t.toFixed(2))).toEqual([
      '249.00',
      '79.90',
    ]);
    expect(price.subtotal.toFixed(2)).toBe('328.90');
    // 328.90 + 7.99 - 32.89 + 26.30
    expect(price.total.toFixed(2)).toBe('330.30');
  });

  it('is exact where floating point is not', () => {
    // 0.1 x 3 is 0.30000000000000004 as doubles.
    const price = priceOrder([{ unitPrice: d('0.10'), quantity: 3 }], none);
    expect(price.subtotal.toFixed(2)).toBe('0.30');
    expect(price.total.equals(d('0.30'))).toBe(true);

    // 19.99 x 3 is 59.97 exactly (59.969999999999995 as doubles).
    expect(
      priceOrder([{ unitPrice: d('19.99'), quantity: 3 }], none).total.toFixed(
        2,
      ),
    ).toBe('59.97');
  });

  it('adds many small lines without drifting', () => {
    const lines = Array.from({ length: 100 }, () => ({
      unitPrice: d('0.01'),
      quantity: 1,
    }));
    expect(priceOrder(lines, none).total.toFixed(2)).toBe('1.00');
  });

  it('prices an order with no discount, shipping or tax at its lines', () => {
    const price = priceOrder([{ unitPrice: d('12.50'), quantity: 4 }], none);
    expect(price.total.toFixed(2)).toBe('50.00');
  });
});

describe('exceedsOrderValue', () => {
  const price = priceOrder([{ unitPrice: d('10.00'), quantity: 1 }], none);

  it('is false up to everything the order is worth, shipping and tax included', () => {
    const adjustments = {
      shipping: d('5.00'),
      discount: d('0'),
      tax: d('1.00'),
    };
    expect(exceedsOrderValue(price, adjustments)).toBe(false);
    expect(
      exceedsOrderValue(price, { ...adjustments, discount: d('16.00') }),
    ).toBe(false);
  });

  it('is true for a discount of even a cent more', () => {
    expect(
      exceedsOrderValue(price, {
        shipping: d('5.00'),
        discount: d('16.01'),
        tax: d('1.00'),
      }),
    ).toBe(true);
  });
});
