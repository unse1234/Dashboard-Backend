import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env.validation';

export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  /** Session id; lets the guard reject tokens whose session was revoked. */
  sid: string;
}

@Injectable()
export class TokenService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly expiresIn: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.issuer = config.getOrThrow('JWT_ISSUER', { infer: true });
    this.audience = config.getOrThrow('JWT_AUDIENCE', { infer: true });
    this.expiresIn = config.getOrThrow('JWT_ACCESS_TTL_SECONDS', {
      infer: true,
    });
  }

  async signAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    const accessToken = await this.jwt.signAsync(payload);
    return { accessToken, expiresIn: this.expiresIn };
  }

  /** Pins the algorithm so tokens signed with "none" or another algorithm are rejected. */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<Partial<AccessTokenPayload>>(
        token,
        {
          algorithms: ['HS256'],
          issuer: this.issuer,
          audience: this.audience,
        },
      );
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('Malformed payload');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
