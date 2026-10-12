import { Prisma } from '../generated/prisma/client';
import { toAmount, toDecimal } from './money';

describe('toAmount', () => {
  it('reads exact decimals, numeric strings and numbers as numbers', () => {
    expect(toAmount(new Prisma.Decimal('19.99'))).toBe(19.99);
    expect(toAmount('5.00')).toBe(5);
    expect(toAmount(12.5)).toBe(12.5);
  });

  it('keeps the largest amount a column holds exact to the cent', () => {
    expect(toAmount(new Prisma.Decimal('9999999999.99'))).toBe(9999999999.99);
  });
});

describe('toDecimal', () => {
  it('turns a two-decimal amount into the exact decimal', () => {
    expect(toDecimal(19.99).toFixed(2)).toBe('19.99');
    expect(toDecimal(0.1).toFixed(2)).toBe('0.10');
    expect(toDecimal(1_000_000).toFixed(2)).toBe('1000000.00');
  });

  it('does not accumulate binary floating-point error across a sum', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as doubles; as decimals it is exact.
    const sum = toDecimal(0.1).plus(toDecimal(0.2));
    expect(sum.equals(toDecimal(0.3))).toBe(true);

    // 3 x 19.99 is 59.97 exactly.
    expect(toDecimal(19.99).times(3).equals(toDecimal(59.97))).toBe(true);
  });
});
