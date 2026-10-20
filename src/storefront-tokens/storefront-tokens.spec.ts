import { sha256 } from '../common/crypto.util';
import {
  createStorefrontToken,
  STOREFRONT_TOKEN_PREFIX,
  storefrontTokenHash,
} from './storefront-tokens';

describe('storefront tokens', () => {
  it('creates 256-bit tokens behind a prefix of their own per purpose', () => {
    const confirmation = createStorefrontToken('ORDER_CONFIRMATION');
    const setup = createStorefrontToken('ACCOUNT_SETUP');
    expect(confirmation).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(setup).toMatch(/^as_[A-Za-z0-9_-]{43}$/);
    expect(createStorefrontToken('ORDER_CONFIRMATION')).not.toBe(confirmation);
    expect(createStorefrontToken('CHECKOUT_RECEIPT')).toMatch(
      /^cr_[A-Za-z0-9_-]{43}$/,
    );
    expect(createStorefrontToken('PASSWORD_RESET')).toMatch(
      /^pr_[A-Za-z0-9_-]{43}$/,
    );
    expect(new Set(Object.values(STOREFRONT_TOKEN_PREFIX)).size).toBe(4);
  });

  it('hashes a token only for its own purpose', () => {
    const token = createStorefrontToken('ORDER_CONFIRMATION');
    expect(storefrontTokenHash(token, 'ORDER_CONFIRMATION')).toBe(
      sha256(token),
    );
    expect(storefrontTokenHash(token, 'ACCOUNT_SETUP')).toBeNull();
  });

  it.each([
    ['no prefix', 'a'.repeat(43)],
    ['a short body', `oc_${'a'.repeat(42)}`],
    ['a long body', `oc_${'a'.repeat(44)}`],
    ['other characters', `oc_${'a'.repeat(42)}=`],
    ['whitespace', ` oc_${'a'.repeat(43)}`],
    ['an empty string', ''],
  ])('refuses %s', (_, token) => {
    expect(storefrontTokenHash(token, 'ORDER_CONFIRMATION')).toBeNull();
  });

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 42, { token: 'x' }, ['oc_']]) {
      expect(storefrontTokenHash(value, 'ORDER_CONFIRMATION')).toBeNull();
    }
  });
});
