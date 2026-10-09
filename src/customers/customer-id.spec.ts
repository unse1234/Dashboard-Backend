import { BadRequestException } from '@nestjs/common';
import {
  customerNumberFromSearch,
  formatCustomerId,
  formatOrderId,
  parseCustomerId,
} from './customer-id';
import { parseCustomerIdParam } from './customer-id.param';

describe('customer ids', () => {
  it('formats public ids', () => {
    expect(formatCustomerId(1001)).toBe('CUS-1001');
    expect(formatOrderId(10001)).toBe('ORD-10001');
  });

  it.each([
    ['CUS-1001', 1001],
    ['cus-1001', 1001],
    ['CUS-1', 1],
    ['CUS-2147483647', 2147483647],
  ])('parses %s', (value, number) => {
    expect(parseCustomerId(value)).toBe(number);
  });

  it.each([
    '1001',
    'CUS1001',
    'CUS-',
    'CUS-0',
    'CUS-01001',
    'CUS-10a',
    ' CUS-1001',
    'CUS-1001 ',
    'ORD-1001',
    'CUS-2147483648',
    'CUS-99999999999',
  ])('rejects %j', (value) => {
    expect(parseCustomerId(value)).toBeNull();
  });

  it.each([
    ['CUS-1001', 1001],
    ['cus-1001', 1001],
    ['cus1001', 1001],
    ['1001', 1001],
  ])('reads the customer number from the search %j', (term, number) => {
    expect(customerNumberFromSearch(term)).toBe(number);
  });

  it.each(['ada', 'CUS-', '555-1001', '0', '2147483648', 'CUS-1001x'])(
    'finds no customer number in the search %j',
    (term) => {
      expect(customerNumberFromSearch(term)).toBeNull();
    },
  );
});

describe('parseCustomerIdParam', () => {
  it('returns the customer number', () => {
    expect(parseCustomerIdParam('CUS-1042')).toBe(1042);
  });

  it.each(['not-an-id', 'CUS-0', undefined, 1042])(
    'rejects %j with 400',
    (value) => {
      expect(() => parseCustomerIdParam(value)).toThrow(BadRequestException);
    },
  );
});
