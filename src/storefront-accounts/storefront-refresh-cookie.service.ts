import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { Env } from '../config/env.validation';
import { StorefrontSessionSettings } from './storefront-account.settings';

/** Not the staff `refresh_token`: a browser may hold both, for different paths. */
export const STOREFRONT_REFRESH_COOKIE = 'sf_refresh_token';
// Browsers send it only to the session routes that use it (sign-in sets it,
// refresh rotates it, sign-out ends it), never to the staff /auth routes.
export const STOREFRONT_REFRESH_COOKIE_PATH = '/storefront/account/session';

/**
 * The storefront refresh cookie: HttpOnly, with Secure, SameSite and Domain
 * from the same COOKIE_* settings as the staff cookie, so one deployment
 * setting fits both.
 */
@Injectable()
export class StorefrontRefreshCookieService {
  private readonly options: CookieOptions;
  private readonly maxAgeMs: number;

  constructor(
    config: ConfigService<Env, true>,
    settings: StorefrontSessionSettings,
  ) {
    this.options = {
      httpOnly: true,
      secure: config.getOrThrow('COOKIE_SECURE', { infer: true }),
      sameSite: config.getOrThrow('COOKIE_SAMESITE', { infer: true }),
      domain: config.get('COOKIE_DOMAIN', { infer: true }),
      path: STOREFRONT_REFRESH_COOKIE_PATH,
    };
    this.maxAgeMs = settings.sessionTtlMs;
  }

  set(response: Response, refreshToken: string): void {
    response.cookie(STOREFRONT_REFRESH_COOKIE, refreshToken, {
      ...this.options,
      maxAge: this.maxAgeMs,
    });
  }

  /** Must use the same attributes as `set`, otherwise the browser keeps the cookie. */
  clear(response: Response): void {
    response.clearCookie(STOREFRONT_REFRESH_COOKIE, this.options);
  }

  read(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[STOREFRONT_REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
