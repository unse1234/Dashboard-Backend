import { hkdfSync } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { STOREFRONT_TOKEN_AUDIENCE, type Env } from '../config/env.validation';
import { StorefrontSessionSettings } from './storefront-account.settings';

/** The claim that marks a storefront (shopper) token as one. */
export const STOREFRONT_TOKEN_TYPE = 'storefront';

export interface StorefrontAccessTokenPayload {
  /** StorefrontAccount id. */
  sub: string;
  /** StorefrontSession id; lets the guard refuse a token whose session ended. */
  sid: string;
}

/**
 * Signs and checks storefront access tokens. Shares nothing that matters with
 * the staff TokenService: the signing key is derived from the server secret
 * under a label of its own, the audience is fixed (and refused as the staff
 * audience), and the payload says `typ: "storefront"`, which the staff guard
 * refuses. A token of either kind therefore fails the other kind's guard on
 * its signature before anything else is compared.
 */
@Injectable()
export class StorefrontAccessTokenService {
  private readonly jwt: JwtService;
  private readonly issuer: string;
  private readonly expiresIn: number;

  constructor(
    config: ConfigService<Env, true>,
    settings: StorefrontSessionSettings,
  ) {
    this.issuer = config.getOrThrow('JWT_ISSUER', { infer: true });
    this.expiresIn = settings.accessTtlSeconds;
    this.jwt = new JwtService({
      secret: Buffer.from(
        hkdfSync(
          'sha256',
          config.getOrThrow('JWT_ACCESS_SECRET', { infer: true }),
          'ecom-dash',
          'storefront-access-token',
          32,
        ),
      ),
      signOptions: {
        algorithm: 'HS256',
        expiresIn: this.expiresIn,
        issuer: this.issuer,
        audience: STOREFRONT_TOKEN_AUDIENCE,
      },
    });
  }

  async sign(
    accountId: string,
    sessionId: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await this.jwt.signAsync({
      sub: accountId,
      sid: sessionId,
      typ: STOREFRONT_TOKEN_TYPE,
    });
    return { accessToken, expiresIn: this.expiresIn };
  }

  /** Pins the algorithm, key, issuer, audience and type. */
  async verify(token: string): Promise<StorefrontAccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<
        Partial<StorefrontAccessTokenPayload> & { typ?: unknown }
      >(token, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: STOREFRONT_TOKEN_AUDIENCE,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        payload.typ !== STOREFRONT_TOKEN_TYPE
      ) {
        throw new Error('Malformed payload');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
