import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../auth/token.service';
import type { Env } from '../config/env.validation';
import { StorefrontAccessTokenService } from './storefront-access-token.service';
import type { StorefrontSessionSettings } from './storefront-account.settings';

const SECRET = 's'.repeat(40);
const values: Record<string, unknown> = {
  JWT_ACCESS_SECRET: SECRET,
  JWT_ISSUER: 'ecom-dash-api',
  JWT_AUDIENCE: 'ecom-dash-dashboard',
  JWT_ACCESS_TTL_SECONDS: 900,
};
const config = {
  getOrThrow: (key: string) => values[key],
} as unknown as ConfigService<Env, true>;

// The staff service exactly as AuthModule configures it.
const staffJwt = new JwtService({
  secret: SECRET,
  signOptions: {
    algorithm: 'HS256',
    expiresIn: 900,
    issuer: 'ecom-dash-api',
    audience: 'ecom-dash-dashboard',
  },
});

describe('StorefrontAccessTokenService', () => {
  const storefront = new StorefrontAccessTokenService(config, {
    accessTtlSeconds: 600,
  } as StorefrontSessionSettings);
  const staff = new TokenService(staffJwt, config);

  it('round-trips account and session, with its own lifetime', async () => {
    const { accessToken, expiresIn } = await storefront.sign('a1', 's1');
    expect(expiresIn).toBe(600);
    await expect(storefront.verify(accessToken)).resolves.toEqual({
      sub: 'a1',
      sid: 's1',
    });
    expect(staffJwt.decode(accessToken)).toMatchObject({
      aud: 'ecom-dash-storefront',
      typ: 'storefront',
    });
  });

  it('is refused by the staff service, and refuses staff tokens', async () => {
    const shopper = (await storefront.sign('a1', 's1')).accessToken;
    const member = (await staff.signAccessToken('u1', 's1')).accessToken;
    await expect(staff.verifyAccessToken(shopper)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(storefront.verify(member)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses tokens that copy its claims but not its key', async () => {
    // Signed with the staff secret itself, claiming the storefront audience.
    const forged = await staffJwt.signAsync(
      { sub: 'a1', sid: 's1', typ: 'storefront' },
      { audience: 'ecom-dash-storefront' },
    );
    await expect(storefront.verify(forged)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // And the staff side refuses any token that says it is another type,
    // even one made with its own key and audience.
    const typed = await staffJwt.signAsync({
      sub: 'u1',
      sid: 's1',
      typ: 'storefront',
    });
    await expect(staff.verifyAccessToken(typed)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
