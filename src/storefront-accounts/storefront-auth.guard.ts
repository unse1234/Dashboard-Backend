import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrderConfirmationSettings } from '../orders/storefront/order-confirmation.settings';
import { StorefrontAccessTokenService } from './storefront-access-token.service';
import {
  StorefrontSessionsService,
  type StorefrontAccountProfile,
} from './storefront-sessions.service';

/** The signed-in shopper, as StorefrontAuthGuard attaches it. */
export interface AuthenticatedStorefrontAccount extends StorefrontAccountProfile {
  sessionId: string;
}

/**
 * A property of its own, never `user`: nothing written for staff requests
 * (`@CurrentUser()`, the roles and email guards) can see a shopper.
 */
type StorefrontRequest = Request & {
  storefrontAccount?: AuthenticatedStorefrontAccount;
};

/**
 * Every storefront account route answers as if it did not exist while
 * STOREFRONT_ACCOUNTS_ENABLED is false: the same 404 Nest gives an unknown
 * route.
 */
@Injectable()
export class StorefrontAccountsEnabledGuard implements CanActivate {
  constructor(private readonly settings: OrderConfirmationSettings) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.settings.accountsEnabled) return true;
    const request = context.switchToHttp().getRequest<Request>();
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl.split('?')[0]}`,
    );
  }
}

/**
 * Requires a storefront access token whose session is still live. Routes
 * using it are @Public() for the staff guards, so a staff token never reaches
 * this guard's lookups as anything but a token with the wrong key, audience
 * and type, and is refused.
 */
@Injectable()
export class StorefrontAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: StorefrontAccessTokenService,
    private readonly sessions: StorefrontSessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StorefrontRequest>();
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedException('Authentication required');

    const payload = await this.tokens.verify(token);
    const session = await this.sessions.findActive(payload.sid);
    if (!session || session.account.id !== payload.sub) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    request.storefrontAccount = { ...session.account, sessionId: session.id };
    return true;
  }
}

/** The shopper StorefrontAuthGuard let through. */
export const CurrentStorefrontAccount = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): AuthenticatedStorefrontAccount => {
    const account = context
      .switchToHttp()
      .getRequest<StorefrontRequest>().storefrontAccount;
    if (!account) throw new UnauthorizedException('Authentication required');
    return account;
  },
);

function bearerToken(request: Request): string | undefined {
  const header = request.get('authorization');
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(' ');
  return scheme.toLowerCase() === 'bearer' && token && rest.length === 0
    ? token
    : undefined;
}
