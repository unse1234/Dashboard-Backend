import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import {
  bearer,
  clearsRefreshCookie,
  createTestApp,
  createUser,
  csrfHeaders,
  login,
  refreshCookie,
  resetDatabase,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

describe('Auth (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  describe('POST /auth/login', () => {
    it('signs in, returns an access token and sets a hardened refresh cookie', async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });

      const res = await http()
        .post('/auth/login')
        .send({ email: 'staff@example.com', password: TEST_PASSWORD })
        .expect(200);

      expect(res.body).toEqual({
        accessToken: expect.any(String),
        tokenType: 'Bearer',
        expiresIn: 900,
        user: expect.objectContaining({
          email: 'staff@example.com',
          role: 'STAFF',
          lastLoginAt: expect.any(String),
        }),
      });
      // Nothing secret may appear in the body.
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refresh/i);
      expect(res.headers['cache-control']).toBe('no-store');

      const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
        (c) => c.startsWith('refresh_token='),
      )!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Path=\/auth/);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Max-Age=604800/);
      expect(cookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false in tests
    });

    it('stores only a hash of the refresh credential', async () => {
      await createUser(ctx.prisma);
      const session = await login(ctx.app, 'staff@example.com');
      const secret = session.cookie.split('=')[1].split('.')[1];

      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.refreshTokenHash).not.toContain(secret);
      expect(row.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('normalizes the email address', async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });
      await http()
        .post('/auth/login')
        .send({ email: '  STAFF@Example.COM ', password: TEST_PASSWORD })
        .expect(200);
    });

    it('gives the same generic error for unknown user, wrong password, disabled and passwordless accounts', async () => {
      await createUser(ctx.prisma, { email: 'ok@example.com' });
      await createUser(ctx.prisma, { email: 'off@example.com', active: false });
      await createUser(ctx.prisma, {
        email: 'invited@example.com',
        password: null,
      });

      const attempts = [
        { email: 'nobody@example.com', password: TEST_PASSWORD },
        { email: 'ok@example.com', password: 'Wrong-Passw0rd!!' },
        { email: 'off@example.com', password: TEST_PASSWORD },
        { email: 'invited@example.com', password: TEST_PASSWORD },
      ];
      for (const body of attempts) {
        const res = await http().post('/auth/login').send(body).expect(401);
        expect(res.body).toEqual({
          message: 'Invalid email or password',
          error: 'Unauthorized',
          statusCode: 401,
        });
        expect(refreshCookie(res)).toBeUndefined();
      }
    });

    it.each([
      ['missing password', { email: 'a@example.com' }],
      ['invalid email', { email: 'not-an-email', password: 'x' }],
      [
        'unknown field',
        { email: 'a@example.com', password: 'x', role: 'ADMIN' },
      ],
      ['non-string password', { email: 'a@example.com', password: 12345 }],
      [
        'oversized password',
        { email: 'a@example.com', password: 'x'.repeat(129) },
      ],
    ])('rejects an invalid payload: %s', async (_name, body) => {
      await http().post('/auth/login').send(body).expect(400);
    });
  });

  describe('access token validation and protected routes', () => {
    it('rejects requests without a token', async () => {
      await http().get('/auth/me').expect(401);
    });

    it.each(['Bearer', 'Bearer not.a.jwt', 'Basic abc', 'Bearer a b'])(
      'rejects malformed Authorization header %p',
      async (header) => {
        await http().get('/auth/me').set('Authorization', header).expect(401);
      },
    );

    it('returns the authenticated user without sensitive fields', async () => {
      await createUser(ctx.prisma, {
        email: 'staff@example.com',
        role: 'ADMIN',
      });
      const { accessToken } = await login(ctx.app, 'staff@example.com');

      const res = await http()
        .get('/auth/me')
        .set(bearer(accessToken))
        .expect(200);
      expect(res.body).toEqual(
        expect.objectContaining({ email: 'staff@example.com', role: 'ADMIN' }),
      );
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('sessionId');
    });

    it('rejects a token signed with a different secret', async () => {
      const user = await createUser(ctx.prisma);
      const { sessionId } = await login(ctx.app, user.email);
      const forged = new JwtService({ secret: 'x'.repeat(48) }).sign(
        { sub: user.id, sid: sessionId },
        { issuer: 'ecom-dash-api', audience: 'ecom-dash-dashboard' },
      );
      await http().get('/auth/me').set(bearer(forged)).expect(401);
    });

    it('rejects an expired token', async () => {
      const user = await createUser(ctx.prisma);
      const { sessionId } = await login(ctx.app, user.email);
      const expired = ctx.app
        .get(JwtService)
        .sign({ sub: user.id, sid: sessionId }, { expiresIn: -10 });
      await http().get('/auth/me').set(bearer(expired)).expect(401);
    });

    it('rejects an unsigned (alg=none) token', async () => {
      const user = await createUser(ctx.prisma);
      const { sessionId } = await login(ctx.app, user.email);
      const enc = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({
        sub: user.id,
        sid: sessionId,
        iss: 'ecom-dash-api',
        aud: 'ecom-dash-dashboard',
        exp: Math.floor(Date.now() / 1000) + 600,
      })}.`;
      await http().get('/auth/me').set(bearer(unsigned)).expect(401);
    });

    it('rejects a token with the wrong algorithm even if the secret matches', async () => {
      const user = await createUser(ctx.prisma);
      const { sessionId } = await login(ctx.app, user.email);
      const enc = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = enc({ alg: 'HS512', typ: 'JWT' });
      const body = enc({
        sub: user.id,
        sid: sessionId,
        iss: 'ecom-dash-api',
        aud: 'ecom-dash-dashboard',
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const sig = createHmac('sha512', process.env.JWT_ACCESS_SECRET!)
        .update(`${head}.${body}`)
        .digest('base64url');
      await http()
        .get('/auth/me')
        .set(bearer(`${head}.${body}.${sig}`))
        .expect(401);
    });

    it('rejects a token whose subject does not own the session', async () => {
      const alice = await createUser(ctx.prisma, {
        email: 'alice@example.com',
      });
      await createUser(ctx.prisma, { email: 'bob@example.com' });
      const bob = await login(ctx.app, 'bob@example.com');
      const mismatched = ctx.app
        .get(JwtService)
        .sign({ sub: alice.id, sid: bob.sessionId });
      await http().get('/auth/me').set(bearer(mismatched)).expect(401);
    });

    it('stops honoring a token when its user is deactivated', async () => {
      const user = await createUser(ctx.prisma);
      const { accessToken } = await login(ctx.app, user.email);
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      await http().get('/auth/me').set(bearer(accessToken)).expect(401);
    });

    it('stops honoring a token when its session is revoked or expired', async () => {
      const user = await createUser(ctx.prisma);
      const first = await login(ctx.app, user.email);
      const second = await login(ctx.app, user.email);

      await ctx.prisma.session.update({
        where: { id: first.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' },
      });
      await ctx.prisma.session.update({
        where: { id: second.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await http().get('/auth/me').set(bearer(first.accessToken)).expect(401);
      await http().get('/auth/me').set(bearer(second.accessToken)).expect(401);
    });

    it('lets unverified users use their own account endpoints', async () => {
      await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'new@example.com');
      await http().get('/auth/me').set(bearer(accessToken)).expect(200);
      await http().get('/auth/sessions').set(bearer(accessToken)).expect(200);
    });
  });

  describe('POST /auth/refresh', () => {
    beforeEach(async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });
    });

    it('rotates the refresh token and issues a new access token', async () => {
      const first = await login(ctx.app, 'staff@example.com');

      const res = await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', first.cookie)
        .expect(200);

      const rotated = refreshCookie(res);
      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(first.cookie);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe('staff@example.com');
      expect(JSON.stringify(res.body)).not.toMatch(/refresh/i);

      // Same session, new credential; the new cookie works and the access token stays valid.
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', rotated!)
        .expect(200);
      await http().get('/auth/me').set(bearer(first.accessToken)).expect(200);
    });

    it('uses one joined SQL read for refresh and each live-session check', async () => {
      const first = await login(ctx.app, 'staff@example.com');
      const user = await ctx.prisma.user.update({
        where: { email: 'staff@example.com' },
        data: { name: 'Updated Staff Name' },
      });
      // Count actual driver SELECTs, rather than ORM calls that can hide
      // additional relation reads. Do not capture parameter values or tokens.
      const querySpy = jest.spyOn(Client.prototype, 'query');
      const selects = () =>
        querySpy.mock.calls
          .map(([query]) =>
            typeof query === 'string'
              ? query
              : ((query as unknown as { text?: string }).text ?? ''),
          )
          .filter((sql) => /^\s*SELECT\b/i.test(sql));
      try {
        const refreshed = await http()
          .post('/auth/refresh')
          .set(csrfHeaders)
          .set('Cookie', first.cookie)
          .expect(200);

        expect(selects()).toHaveLength(1);
        expect(selects()[0]).toContain('JOIN "User" u');
        expect(refreshed.body.user).toMatchObject({
          id: user.id,
          name: user.name,
          emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        });
        expect(JSON.stringify(refreshed.body)).not.toMatch(
          /passwordHash|refreshTokenHash|previousRefreshTokenHash/,
        );
        expect(refreshed.headers['server-timing']).toMatch(
          /session_lookup;dur=[\d.]+/,
        );
        expect(refreshed.headers['server-timing']).toContain(
          'session_rotate;dur=',
        );
        expect(refreshed.headers['server-timing']).toContain('jwt_sign;dur=');
        expect(refreshed.headers['timing-allow-origin']).toBe(
          csrfHeaders.Origin,
        );
        expect(refreshed.headers['access-control-expose-headers']).toBe(
          'Server-Timing,X-Request-Id',
        );

        querySpy.mockClear();
        const me = await http()
          .get('/auth/me')
          .set(bearer(first.accessToken))
          .expect(200);
        expect(selects()).toHaveLength(1);
        expect(selects()[0]).toContain('JOIN "User" u');
        expect(me.body).toEqual(refreshed.body.user);
        expect(me.headers['server-timing']).toContain('db_count;desc="1"');
        expect(me.headers['server-timing']).toContain('jwt_verify;dur=');
        expect(me.headers['x-request-id']).not.toBe(
          refreshed.headers['x-request-id'],
        );
      } finally {
        querySpy.mockRestore();
      }
    });

    it('requires an allowed origin and the CSRF header', async () => {
      const { cookie } = await login(ctx.app, 'staff@example.com');
      const cases: Record<string, string>[] = [
        {}, // neither
        { Origin: 'http://localhost:3000' }, // header missing
        { 'X-CSRF-Protection': '1' }, // origin missing
        { Origin: 'https://evil.example', 'X-CSRF-Protection': '1' }, // wrong origin
        { Origin: 'http://localhost:3000', 'X-CSRF-Protection': 'yes' }, // wrong value
      ];
      for (const headers of cases) {
        await http()
          .post('/auth/refresh')
          .set(headers)
          .set('Cookie', cookie)
          .expect(403);
      }
      // None of the rejected attempts consumed the token.
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', cookie)
        .expect(200);
    });

    it('accepts the Referer origin when Origin is absent', async () => {
      const { cookie } = await login(ctx.app, 'staff@example.com');
      await http()
        .post('/auth/refresh')
        .set({
          Referer: 'http://localhost:3000/dashboard',
          'X-CSRF-Protection': '1',
        })
        .set('Cookie', cookie)
        .expect(200);
    });

    it('rejects a missing or malformed cookie', async () => {
      await http().post('/auth/refresh').set(csrfHeaders).expect(401);
      for (const value of [
        'refresh_token=garbage',
        'refresh_token=not-a-uuid.secret',
        `refresh_token=${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.secret`,
      ]) {
        await http()
          .post('/auth/refresh')
          .set(csrfHeaders)
          .set('Cookie', value)
          .expect(401);
      }
    });

    it('revokes the session when an old token is replayed after the grace window', async () => {
      const first = await login(ctx.app, 'staff@example.com');
      const res = await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', first.cookie)
        .expect(200);
      const rotated = refreshCookie(res)!;

      // Pretend the rotation happened a minute ago, then replay the stolen token.
      await ctx.prisma.session.update({
        where: { id: first.sessionId },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
      const replay = await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', first.cookie)
        .expect(401);
      expect(clearsRefreshCookie(replay)).toBe(true);

      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: first.sessionId },
      });
      expect(row.revokedReason).toBe('REUSE_DETECTED');
      expect(row.revokedAt).not.toBeNull();

      // The legitimate holder of the newest token is cut off too, and so is the access token.
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', rotated)
        .expect(401);
      await http().get('/auth/me').set(bearer(first.accessToken)).expect(401);
    });

    it('treats a replay inside the grace window as a lost race, not theft', async () => {
      const first = await login(ctx.app, 'staff@example.com');
      const res = await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', first.cookie)
        .expect(200);
      const rotated = refreshCookie(res)!;

      const replay = await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', first.cookie)
        .expect(401);
      // Must not wipe the cookie the winning request just set.
      expect(clearsRefreshCookie(replay)).toBe(false);

      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: first.sessionId },
      });
      expect(row.revokedAt).toBeNull();
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', rotated)
        .expect(200);
    });

    it('lets exactly one of several concurrent refreshes win without revoking the session', async () => {
      const first = await login(ctx.app, 'staff@example.com');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          http()
            .post('/auth/refresh')
            .set(csrfHeaders)
            .set('Cookie', first.cookie),
        ),
      );

      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 401);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);
      for (const loser of losers)
        expect(clearsRefreshCookie(loser)).toBe(false);

      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: first.sessionId },
      });
      expect(row.revokedAt).toBeNull();
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', refreshCookie(winners[0])!)
        .expect(200);
    });

    it('rejects expired, revoked and deactivated-user sessions and clears the cookie', async () => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'staff@example.com' },
      });

      const expired = await login(ctx.app, 'staff@example.com');
      await ctx.prisma.session.update({
        where: { id: expired.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const revoked = await login(ctx.app, 'staff@example.com');
      await ctx.prisma.session.update({
        where: { id: revoked.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' },
      });
      const disabled = await login(ctx.app, 'staff@example.com');
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });

      for (const { cookie } of [expired, revoked, disabled]) {
        const res = await http()
          .post('/auth/refresh')
          .set(csrfHeaders)
          .set('Cookie', cookie)
          .expect(401);
        expect(clearsRefreshCookie(res)).toBe(true);
      }
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session, clears the cookie and invalidates the access token', async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });
      const session = await login(ctx.app, 'staff@example.com');

      const res = await http()
        .post('/auth/logout')
        .set(csrfHeaders)
        .set('Cookie', session.cookie)
        .expect(204);
      expect(clearsRefreshCookie(res)).toBe(true);

      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.revokedReason).toBe('LOGOUT');
      await http().get('/auth/me').set(bearer(session.accessToken)).expect(401);
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', session.cookie)
        .expect(401);
    });

    it('succeeds idempotently without a cookie', async () => {
      const res = await http()
        .post('/auth/logout')
        .set(csrfHeaders)
        .expect(204);
      expect(clearsRefreshCookie(res)).toBe(true);
    });

    it('requires CSRF protection and ignores forged cookies', async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });
      const session = await login(ctx.app, 'staff@example.com');

      await http()
        .post('/auth/logout')
        .set('Cookie', session.cookie)
        .expect(403);
      // Right session id, wrong secret: must not revoke anything.
      await http()
        .post('/auth/logout')
        .set(csrfHeaders)
        .set('Cookie', `refresh_token=${session.sessionId}.forged-secret`)
        .expect(204);
      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.revokedAt).toBeNull();
    });
  });

  describe('sessions', () => {
    it('lists only active sessions of the caller and marks the current one', async () => {
      await createUser(ctx.prisma, { email: 'alice@example.com' });
      await createUser(ctx.prisma, { email: 'bob@example.com' });
      const a1 = await login(ctx.app, 'alice@example.com');
      const a2 = await login(ctx.app, 'alice@example.com');
      await login(ctx.app, 'bob@example.com');
      await ctx.prisma.session.update({
        where: { id: a2.sessionId },
        data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
      });
      const a3 = await login(ctx.app, 'alice@example.com');

      const res = await http()
        .get('/auth/sessions')
        .set(bearer(a1.accessToken))
        .expect(200);
      const sessions = res.body as { id: string; current: boolean }[];
      expect(sessions.map((s) => s.id).sort()).toEqual(
        [a1.sessionId, a3.sessionId].sort(),
      );
      expect(sessions.find((s) => s.id === a1.sessionId)?.current).toBe(true);
      expect(sessions.find((s) => s.id === a3.sessionId)?.current).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/hash|secret|token/i);
    });

    it('revokes an owned session', async () => {
      await createUser(ctx.prisma, { email: 'alice@example.com' });
      const laptop = await login(ctx.app, 'alice@example.com');
      const phone = await login(ctx.app, 'alice@example.com');

      await http()
        .delete(`/auth/sessions/${phone.sessionId}`)
        .set(bearer(laptop.accessToken))
        .expect(204);

      await http().get('/auth/me').set(bearer(phone.accessToken)).expect(401);
      await http().get('/auth/me').set(bearer(laptop.accessToken)).expect(200);
      // Already revoked now.
      await http()
        .delete(`/auth/sessions/${phone.sessionId}`)
        .set(bearer(laptop.accessToken))
        .expect(404);
    });

    it("cannot revoke or discover another user's session", async () => {
      await createUser(ctx.prisma, { email: 'alice@example.com' });
      await createUser(ctx.prisma, { email: 'bob@example.com' });
      const alice = await login(ctx.app, 'alice@example.com');
      const bob = await login(ctx.app, 'bob@example.com');

      await http()
        .delete(`/auth/sessions/${bob.sessionId}`)
        .set(bearer(alice.accessToken))
        .expect(404);
      await http()
        .delete('/auth/sessions/00000000-0000-4000-8000-000000000000')
        .set(bearer(alice.accessToken))
        .expect(404);
      await http().get('/auth/me').set(bearer(bob.accessToken)).expect(200);
    });

    it('rejects a non-UUID id and unauthenticated calls', async () => {
      await createUser(ctx.prisma, { email: 'alice@example.com' });
      const alice = await login(ctx.app, 'alice@example.com');
      await http()
        .delete('/auth/sessions/abc')
        .set(bearer(alice.accessToken))
        .expect(400);
      await http().delete(`/auth/sessions/${alice.sessionId}`).expect(401);
      await http().get('/auth/sessions').expect(401);
    });
  });

  describe('PATCH /auth/change-password', () => {
    const NEW_PASSWORD = 'An0ther-Str0ng-Pass';

    beforeEach(async () => {
      await createUser(ctx.prisma, { email: 'staff@example.com' });
    });

    it('changes the password and revokes every other session', async () => {
      const current = await login(ctx.app, 'staff@example.com');
      const other = await login(ctx.app, 'staff@example.com');

      await http()
        .patch('/auth/change-password')
        .set(bearer(current.accessToken))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await http().get('/auth/me').set(bearer(current.accessToken)).expect(200);
      await http().get('/auth/me').set(bearer(other.accessToken)).expect(401);
      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: other.sessionId },
      });
      expect(row.revokedReason).toBe('PASSWORD_CHANGED');

      await http()
        .post('/auth/login')
        .send({ email: 'staff@example.com', password: TEST_PASSWORD })
        .expect(401);
      await http()
        .post('/auth/login')
        .send({ email: 'staff@example.com', password: NEW_PASSWORD })
        .expect(200);
    });

    it('rejects a wrong current password, a weak new password and an unchanged password', async () => {
      const { accessToken } = await login(ctx.app, 'staff@example.com');
      const patch = (body: object) =>
        http()
          .patch('/auth/change-password')
          .set(bearer(accessToken))
          .send(body);

      await patch({
        currentPassword: 'Nope-Nope-Nope1',
        newPassword: NEW_PASSWORD,
      }).expect(400);
      await patch({
        currentPassword: TEST_PASSWORD,
        newPassword: 'short1A',
      }).expect(400);
      await patch({
        currentPassword: TEST_PASSWORD,
        newPassword: 'alllowercase1234',
      }).expect(400);
      await patch({
        currentPassword: TEST_PASSWORD,
        newPassword: 'NoDigitsHereAtAll',
      }).expect(400);
      await patch({
        currentPassword: TEST_PASSWORD,
        newPassword: TEST_PASSWORD,
      }).expect(400);
      await patch({ currentPassword: TEST_PASSWORD }).expect(400);
      await http()
        .patch('/auth/change-password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
    });
  });
});
