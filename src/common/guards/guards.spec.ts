import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { SessionsService } from '../../auth/sessions.service';
import type { TokenService } from '../../auth/token.service';
import { AllowUnverified } from '../decorators/allow-unverified.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { CsrfGuard } from './csrf.guard';
import { EmailVerifiedGuard } from './email-verified.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

class Controller {
  open() {}
  @Public() publicRoute() {}
  @Roles('ADMIN') adminOnly() {}
  @Roles('ADMIN', 'STAFF') anyStaff() {}
  @AllowUnverified() unverifiedOk() {}
}

function context(
  request: object,
  handler: (...args: never[]) => unknown = Controller.prototype.open,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = (overrides: object = {}) => ({
  user: { role: 'STAFF', emailVerifiedAt: new Date(), ...overrides },
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows routes without role metadata and public routes', () => {
    expect(guard.canActivate(context(user()))).toBe(true);
    expect(
      guard.canActivate(context({}, Controller.prototype.publicRoute)),
    ).toBe(true);
  });

  it('allows a listed role and denies others', () => {
    const admin = Controller.prototype.adminOnly;
    expect(guard.canActivate(context(user({ role: 'ADMIN' }), admin))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(context(user({ role: 'STAFF' }), admin)),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(
        context(user({ role: 'STAFF' }), Controller.prototype.anyStaff),
      ),
    ).toBe(true);
  });

  it('denies when no user is attached', () => {
    expect(() =>
      guard.canActivate(context({}, Controller.prototype.adminOnly)),
    ).toThrow(ForbiddenException);
  });
});

describe('EmailVerifiedGuard', () => {
  const guard = new EmailVerifiedGuard(new Reflector());

  it('requires a verified email by default', () => {
    expect(guard.canActivate(context(user()))).toBe(true);
    expect(() =>
      guard.canActivate(context(user({ emailVerifiedAt: null }))),
    ).toThrow(ForbiddenException);
  });

  it('skips public and @AllowUnverified routes', () => {
    const unverified = user({ emailVerifiedAt: null });
    expect(
      guard.canActivate(context(unverified, Controller.prototype.publicRoute)),
    ).toBe(true);
    expect(
      guard.canActivate(context(unverified, Controller.prototype.unverifiedOk)),
    ).toBe(true);
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard({
    getOrThrow: () => 'http://localhost:3000, https://admin.example.com',
  } as unknown as ConfigService<never, true>);

  const req = (headers: Record<string, string>) => ({
    get: (name: string) => headers[name.toLowerCase()],
  });

  it('accepts an allowed Origin with the custom header', () => {
    expect(
      guard.canActivate(
        context(
          req({
            origin: 'https://admin.example.com',
            'x-csrf-protection': '1',
          }),
        ),
      ),
    ).toBe(true);
  });

  it('falls back to the Referer origin', () => {
    expect(
      guard.canActivate(
        context(
          req({
            referer: 'http://localhost:3000/a/b?c=d',
            'x-csrf-protection': '1',
          }),
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['no origin', { 'x-csrf-protection': '1' }],
    [
      'foreign origin',
      { origin: 'https://evil.example', 'x-csrf-protection': '1' },
    ],
    [
      'origin with a different port',
      { origin: 'http://localhost:3001', 'x-csrf-protection': '1' },
    ],
    ['unparseable referer', { referer: 'nope', 'x-csrf-protection': '1' }],
    ['missing header', { origin: 'http://localhost:3000' }],
    [
      'wrong header value',
      { origin: 'http://localhost:3000', 'x-csrf-protection': '0' },
    ],
  ])('rejects %s', (_name, headers) => {
    expect(() => guard.canActivate(context(req(headers)))).toThrow(
      ForbiddenException,
    );
  });
});

describe('JwtAuthGuard', () => {
  const sessionUser = { id: 'u1', role: 'STAFF' };
  const tokens = { verifyAccessToken: jest.fn() };
  const sessions = { findActive: jest.fn() };
  const guard = new JwtAuthGuard(
    new Reflector(),
    tokens as unknown as TokenService,
    sessions as unknown as SessionsService,
  );
  const req = (authorization?: string) => ({
    get: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('lets public routes through without looking at the token', async () => {
    await expect(
      guard.canActivate(context({}, Controller.prototype.publicRoute)),
    ).resolves.toBe(true);
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-bearer header', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer', 'Bearer a b']) {
      await expect(
        guard.canActivate(context(req(header))),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('attaches the user and session id for a valid token with a live session', async () => {
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'u1', sid: 's1' });
    sessions.findActive.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      user: sessionUser,
    });
    const request = req('bearer good.token.here');

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect((request as { user?: unknown }).user).toEqual({
      ...sessionUser,
      sessionId: 's1',
    });
  });

  it('rejects when the session is gone, or belongs to someone else', async () => {
    tokens.verifyAccessToken.mockResolvedValue({ sub: 'u1', sid: 's1' });

    sessions.findActive.mockResolvedValue(null);
    await expect(
      guard.canActivate(context(req('Bearer t'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    sessions.findActive.mockResolvedValue({
      id: 's1',
      userId: 'someone-else',
      user: sessionUser,
    });
    await expect(
      guard.canActivate(context(req('Bearer t'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('propagates token verification failures', async () => {
    tokens.verifyAccessToken.mockRejectedValue(new UnauthorizedException());
    await expect(
      guard.canActivate(context(req('Bearer t'))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.findActive).not.toHaveBeenCalled();
  });
});
