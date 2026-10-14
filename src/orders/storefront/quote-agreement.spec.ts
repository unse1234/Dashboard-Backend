import { Prisma } from '../../generated/prisma/client';
import { pricedMismatch, requestMismatch } from './quote-agreement';
import type { QuoteClaims } from './quote-token.service';

const claims: QuoteClaims = {
  currency: 'PKR',
  items: [
    [1001, 2],
    [1002, 1],
  ],
  unitPrices: ['199.99', '0.10'],
  destination: { country: 'PK', region: 'punjab' },
  subtotal: '400.08',
  shipping: '0.00',
  tax: '0.00',
  discount: '0.00',
  total: '400.08',
};

const dec = (value: string) => new Prisma.Decimal(value);
const priced = (
  overrides: Partial<Parameters<typeof pricedMismatch>[1]> = {},
) => ({
  lines: [
    { number: 1002, unitPrice: dec('0.10') },
    { number: 1001, unitPrice: dec('199.99') },
  ],
  subtotal: dec('400.08'),
  total: dec('400.08'),
  ...overrides,
});

describe('requestMismatch', () => {
  const lines = [
    { number: 1002, quantity: 1 },
    { number: 1001, quantity: 2 },
  ];

  it('accepts the quoted bag in any order, and the province in any case', () => {
    expect(requestMismatch(claims, lines, '  Punjab ')).toBeNull();
  });

  it.each([
    [
      'a quantity',
      [
        { number: 1001, quantity: 3 },
        { number: 1002, quantity: 1 },
      ],
    ],
    ['a missing line', [{ number: 1001, quantity: 2 }]],
    [
      'an extra line',
      [
        { number: 1001, quantity: 2 },
        { number: 1002, quantity: 1 },
        { number: 1003, quantity: 1 },
      ],
    ],
    [
      'another product',
      [
        { number: 1001, quantity: 2 },
        { number: 1009, quantity: 1 },
      ],
    ],
  ])('notices %s', (_name, changed) => {
    expect(requestMismatch(claims, changed, 'Punjab')).toBe('ITEMS_CHANGED');
  });

  it('notices another province', () => {
    expect(requestMismatch(claims, lines, 'Sindh')).toBe('DESTINATION_CHANGED');
  });
});

describe('pricedMismatch', () => {
  it('accepts the quoted prices and amounts', () => {
    expect(pricedMismatch(claims, priced())).toBeNull();
  });

  it('notices a unit price that moved by a cent', () => {
    expect(
      pricedMismatch(
        claims,
        priced({
          lines: [
            { number: 1001, unitPrice: dec('200.00') },
            { number: 1002, unitPrice: dec('0.10') },
          ],
        }),
      ),
    ).toBe('PRICES_CHANGED');
  });

  it('notices an amount that no longer adds up to the quote', () => {
    expect(pricedMismatch(claims, priced({ total: dec('400.09') }))).toBe(
      'TOTAL_CHANGED',
    );
  });

  it('notices a charge the quote did not include', () => {
    expect(pricedMismatch({ ...claims, shipping: '150.00' }, priced())).toBe(
      'TOTAL_CHANGED',
    );
  });
});
