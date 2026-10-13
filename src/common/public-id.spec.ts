import { BadRequestException } from '@nestjs/common';
import {
  formatPublicId,
  numberFromSearch,
  parsePublicId,
  type PublicIdPrefix,
} from './public-id';
import { parsePublicIdParam } from './public-id.param';

const PREFIXES: PublicIdPrefix[] = ['CUS', 'ORD', 'PRD', 'IMP'];

describe.each(PREFIXES)('public ids with the prefix %s', (prefix) => {
  it('formats the number', () => {
    expect(formatPublicId(prefix, 1001)).toBe(`${prefix}-1001`);
  });

  it.each([
    [`${prefix}-1001`, 1001],
    [`${prefix.toLowerCase()}-1001`, 1001],
    [`${prefix}-1`, 1],
    [`${prefix}-2147483647`, 2147483647],
  ])('parses %s', (value, number) => {
    expect(parsePublicId(prefix, value)).toBe(number);
  });

  it.each([
    '1001',
    `${prefix}1001`,
    `${prefix}-`,
    `${prefix}-0`,
    `${prefix}-01001`,
    `${prefix}-10a`,
    ` ${prefix}-1001`,
    `${prefix}-1001 `,
    `${prefix}-2147483648`,
    `${prefix}-99999999999`,
    `${prefix}--1`,
  ])('rejects %j', (value) => {
    expect(parsePublicId(prefix, value)).toBeNull();
  });

  it('does not accept another kind of id', () => {
    for (const other of PREFIXES.filter((p) => p !== prefix)) {
      expect(parsePublicId(prefix, `${other}-1001`)).toBeNull();
    }
  });

  it.each([
    [`${prefix}-1001`, 1001],
    [`${prefix.toLowerCase()}-1001`, 1001],
    [`${prefix.toLowerCase()}1001`, 1001],
    ['1001', 1001],
  ])('reads the number from the search %j', (term, number) => {
    expect(numberFromSearch(prefix, term)).toBe(number);
  });

  it.each(['ada', `${prefix}-`, '555-1001', '0', '2147483648', `${prefix}-1x`])(
    'finds no number in the search %j',
    (term) => {
      expect(numberFromSearch(prefix, term)).toBeNull();
    },
  );
});

describe('parsePublicIdParam', () => {
  it('returns the number', () => {
    expect(parsePublicIdParam('PRD', 'PRD-1042')).toBe(1042);
    expect(parsePublicIdParam('ORD', 'ord-10001')).toBe(10001);
  });

  it.each(['not-an-id', 'PRD-0', 'CUS-1001', undefined, 1042, null])(
    'rejects %j with 400',
    (value) => {
      expect(() => parsePublicIdParam('PRD', value)).toThrow(
        BadRequestException,
      );
    },
  );

  it('names the kind of id that was expected', () => {
    expect(() => parsePublicIdParam('PRD', 'x')).toThrow(
      'a product id like "PRD-1001"',
    );
    expect(() => parsePublicIdParam('ORD', 'x')).toThrow(
      'an order id like "ORD-1001"',
    );
    expect(() => parsePublicIdParam('CUS', 'x')).toThrow(
      'a customer id like "CUS-1001"',
    );
  });
});
