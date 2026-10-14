import { Prisma } from '../generated/prisma/client';
import { marginOf } from './product.mapper';

const dec = (value: string) => new Prisma.Decimal(value);

describe('marginOf', () => {
  it('is profit as a share of the selling price', () => {
    expect(marginOf(dec('12.50'), dec('4.25'))).toBe(0.66);
    expect(marginOf(dec('100'), dec('74.5'))).toBe(0.255);
  });

  it('rounds to four decimals, in exact decimals', () => {
    // 19.89 / 19.99 = 0.99499749...: a float division would not be asked for.
    expect(marginOf(dec('19.99'), dec('0.10'))).toBe(0.995);
    expect(marginOf(dec('3.00'), dec('1.00'))).toBe(0.6667);
  });

  it('is zero at cost and negative below it', () => {
    expect(marginOf(dec('10'), dec('10'))).toBe(0);
    expect(marginOf(dec('10'), dec('12.5'))).toBe(-0.25);
  });

  it('is null without a cost price, or at a price of zero', () => {
    expect(marginOf(dec('10'), null)).toBeNull();
    expect(marginOf(dec('0'), dec('5'))).toBeNull();
  });
});
