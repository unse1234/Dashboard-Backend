import { generateToken, safeEqual, sha256 } from './crypto.util';

describe('crypto.util', () => {
  it('generates unique URL-safe tokens with 256 bits of entropy', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex characters', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares strings in constant time without throwing on length mismatch', () => {
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'much longer value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
