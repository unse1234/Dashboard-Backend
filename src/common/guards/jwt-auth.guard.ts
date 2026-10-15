import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SessionsService } from '../../auth/sessions.service';
import { TokenService } from '../../auth/token.service';
import type { AuthenticatedRequest } from '../authenticated-user';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { measureOperation } from '../observability/request-timing';

/**
 * Global guard: every route requires a valid access token unless marked @Public().
 * The token alone is not enough; its session must still be live and its user active,
 * so logout, revocation, deactivation and role changes apply immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    if (!token) throw new UnauthorizedException('Authentication required');

    const payload = await measureOperation('jwt_verify', () =>
      this.tokens.verifyAccessToken(token),
    );
    const session = await this.sessions.findActive(payload.sid);
    if (!session || session.userId !== payload.sub) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    (request as AuthenticatedRequest).user = {
      ...session.user,
      sessionId: session.id,
    };
    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const header = request.get('authorization');
    if (!header) return undefined;
    const [scheme, token, ...rest] = header.split(' ');
    return scheme.toLowerCase() === 'bearer' && token && rest.length === 0
      ? token
      : undefined;
  }
}
