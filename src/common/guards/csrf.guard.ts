import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { parseOrigins, type Env } from '../../config/env.validation';

export const CSRF_HEADER = 'x-csrf-protection';

/**
 * CSRF defence for endpoints authenticated by the refresh cookie. A request must
 * come from an allowed origin AND carry a custom header, which browsers only
 * send cross-origin after a CORS preflight that non-allowed origins fail.
 * The cookie is also SameSite and scoped to /auth.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(config: ConfigService<Env, true>) {
    this.allowedOrigins = new Set(
      parseOrigins(config.getOrThrow('CORS_ORIGINS', { infer: true })),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const origin =
      request.get('origin') ?? this.originOf(request.get('referer'));
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new ForbiddenException('Request origin not allowed');
    }
    if (request.get(CSRF_HEADER) !== '1') {
      throw new ForbiddenException('Missing CSRF protection header');
    }
    return true;
  }

  private originOf(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }
}
