import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation';
import { QuoteTokenService, type QuoteClaims } from './quote-token.service';

const config = (
  overrides: Partial<Record<keyof Env, unknown>> = {},
): ConfigService<Env, true> => {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    QUOTE_TTL_MINUTES: 30,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<Env, true>;
};

const claims: QuoteClaims = {
  currency: 'PKR',
  items: [
    [1001, 2],
    [1003, 1],
  ],
  unitPrices: ['1500.00', '99.50'],
  destination: { country: 'PK', region: 'punjab' },
  subtotal: '3099.50',
  shipping: '0.00',
  tax: '0.00',
  discount: '0.00',
  total: '3099.50',
};

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MINUTE_MS = 60_000;

describe('QuoteTokenService', () => {
  const service = new QuoteTokenService(config());

  it('returns the claims it issued, and when they stop being accepted', () => {
    const { token, expiresAt } = service.issue(claims, NOW);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 30 * MINUTE_MS));

    const result = service.verify(token, NOW);
    expect(result).toEqual({ status: 'valid', claims, expiresAt });
  });

  it('is valid until the last second of its lifetime, then expired', () => {
    const { token, expiresAt } = service.issue(claims, NOW);
    expect(
      service.verify(token, new Date(expiresAt.getTime() - 1000)).status,
    ).toBe('valid');
    const late = service.verify(token, expiresAt);
    // Expired, but still readable: a caller can tell stale from forged.
    expect(late).toMatchObject({ status: 'expired', claims });
  });

  it('uses the configured lifetime', () => {
    const quick = new QuoteTokenService(config({ QUOTE_TTL_MINUTES: 2 }));
    const { expiresAt } = quick.issue(claims, NOW);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 2 * MINUTE_MS));
  });

  it('is opaque: the token is not the claims in the clear signed with a guessable key', () => {
    const { token } = service.issue(claims, NOW);
    expect(token.split('.')).toHaveLength(2);
    // A different server secret cannot verify it.
    const other = new QuoteTokenService(
      config({ JWT_ACCESS_SECRET: 'b'.repeat(40) }),
    );
    expect(other.verify(token, NOW)).toEqual({ status: 'invalid' });
  });

  it('rejects a token whose claims were altered', () => {
    const { token } = service.issue(claims, NOW);
    const [body, signature] = token.split('.');
    const decoded = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, total: '1.00' }),
    ).toString('base64url');
    expect(service.verify(`${forged}.${signature}`, NOW)).toEqual({
      status: 'invalid',
    });
  });

  it('rejects an altered expiry', () => {
    const { token } = service.issue(claims, NOW);
    const [body, signature] = token.split('.');
    const decoded = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as { exp: number };
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, exp: decoded.exp + 86_400 }),
    ).toString('base64url');
    expect(service.verify(`${forged}.${signature}`, NOW).status).toBe(
      'invalid',
    );
  });

  it.each([
    ['empty', ''],
    ['no dot', 'abcdef'],
    ['three parts', 'a.b.c'],
    ['not base64', '!!!.???'],
    ['a signature of the wrong length', 'e30.AAAA'],
    ['very long', 'a'.repeat(20_000)],
  ])('rejects a token that is %s', (_label, token) => {
    expect(service.verify(token, NOW)).toEqual({ status: 'invalid' });
  });

  it('rejects a correctly signed token of an unknown shape', () => {
    // Signed by us, but not a quote: e.g. some other document that was signed.
    const sign = (
      service as unknown as { sign(body: string): string }
    ).sign.bind(service);
    const body = Buffer.from(JSON.stringify({ v: 2, exp: 1 })).toString(
      'base64url',
    );
    expect(service.verify(`${body}.${sign(body)}`, NOW)).toEqual({
      status: 'invalid',
    });
  });

  it('keeps nothing between issues: two quotes of one bag differ only in time', () => {
    const a = service.issue(claims, NOW).token;
    const b = service.issue(claims, NOW).token;
    expect(a).toBe(b);
    const later = service.issue(claims, new Date(NOW.getTime() + 1000)).token;
    expect(later).not.toBe(a);
  });
});
