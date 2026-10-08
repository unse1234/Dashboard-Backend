import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../authenticated-user';
import { ALLOW_UNVERIFIED_KEY } from '../decorators/allow-unverified.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Users with an unverified email can sign in and manage their own account, but
 * every route not marked @AllowUnverified() requires a verified address.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, targets)
    ) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user?.emailVerifiedAt) {
      throw new ForbiddenException('Email verification required');
    }
    return true;
  }
}
