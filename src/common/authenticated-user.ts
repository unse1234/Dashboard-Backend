import type { Request } from 'express';
import type { PublicUser } from '../users/public-user';

/** Attached to the request by JwtAuthGuard for every non-public route. */
export type AuthenticatedUser = PublicUser & { sessionId: string };

export type AuthenticatedRequest = Request & { user: AuthenticatedUser };
