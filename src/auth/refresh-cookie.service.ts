import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../config/env.validation';

export const REFRESH_COOKIE = 'refresh_token';
// Browsers only send the cookie to the auth routes that need it.
export const REFRESH_COOKIE_PATH = '/auth';

@Injectable()
export class RefreshCookieService {
  private readonly options: CookieOptions;
  private readonly maxAgeMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.options = {
      httpOnly: true,
      secure: config.getOrThrow('COOKIE_SECURE', { infer: true }),
      sameSite: config.getOrThrow('COOKIE_SAMESITE', { infer: true }),
      domain: config.get('COOKIE_DOMAIN', { infer: true }),
      path: REFRESH_COOKIE_PATH,
    };
    this.maxAgeMs =
      config.getOrThrow('REFRESH_TOKEN_TTL_DAYS', { infer: true }) *
      24 *
      60 *
      60 *
      1000;
  }

  set(response: Response, refreshToken: string): void {
    response.cookie(REFRESH_COOKIE, refreshToken, {
      ...this.options,
      maxAge: this.maxAgeMs,
    });
  }

  /** Must use the same attributes as `set`, otherwise the browser keeps the cookie. */
  clear(response: Response): void {
    response.clearCookie(REFRESH_COOKIE, this.options);
  }

  read(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
