import request from 'supertest';
import { UsersService } from '../src/users/users.service';
import {
  bearer,
  createTestApp,
  createUser,
  csrfHeaders,
  login,
  resetDatabase,
  tokenFrom,
  TEST_PASSWORD,
  type LoginSession,
  type TestContext,
} from './helpers';

// Every sign-in runs a deliberately slow Argon2id verification, and several tests here
// sign in more than once. Jest's 5 s default is too tight on a loaded machine.
jest.setTimeout(30_000);

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Exactly the fields the API may ever return for a user. */
const PROFILE_FIELDS = [
  'createdAt',
  'email',
  'emailVerifiedAt',
  'id',
  'isActive',
  'lastLoginAt',
  'name',
  'role',
  'updatedAt',
];

interface Account extends LoginSession {
  id: string;
  email: string;
}

describe('User management (e2e)', () => {
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
    ctx.mail.clear();
  });

  /** Creates a verified user and signs them in. */
  async function account(
    email: string,
    role: 'ADMIN' | 'STAFF',
    options: { verified?: boolean; name?: string } = {},
  ): Promise<Account> {
    const user = await createUser(ctx.prisma, { email, role, ...options });
    return { id: user.id, email, ...(await login(ctx.app, email)) };
  }
  const admin = (email = 'admin@example.com') => account(email, 'ADMIN');
  const staff = (email = 'staff@example.com') => account(email, 'STAFF');

  const row = (id: string) =>
    ctx.prisma.user.findUniqueOrThrow({ where: { id } });
  const liveSessions = (userId: string) =>
    ctx.prisma.session.count({ where: { userId, revokedAt: null } });
  const activeAdmins = () =>
    ctx.prisma.user.count({
      where: { role: 'ADMIN', isActive: true, deletedAt: null },
    });

  const refresh = (session: LoginSession) =>
    http().post('/auth/refresh').set(csrfHeaders).set('Cookie', session.cookie);

  /** Every protected endpoint the account could reach must now refuse it. */
  async function expectLockedOut(session: LoginSession, email: string) {
    await http().get('/users/me').set(bearer(session.accessToken)).expect(401);
    await http().get('/auth/me').set(bearer(session.accessToken)).expect(401);
    await refresh(session).expect(401);
    await http()
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(401);
  }

  describe('PATCH /users/me', () => {
    const patchMe = (token: string, body: object) =>
      http().patch('/users/me').set(bearer(token)).send(body);

    it.each(['ADMIN', 'STAFF'] as const)(
      'lets a %s rename themselves and returns only allowlisted fields',
      async (role) => {
        const me = await account('me@example.com', role);
        const other = await createUser(ctx.prisma, {
          email: 'other@example.com',
          name: 'Untouched',
        });

        const res = await patchMe(me.accessToken, {
          name: '  New Name  ',
        }).expect(200);

        expect(res.body).toEqual(
          expect.objectContaining({
            id: me.id,
            name: 'New Name',
            email: 'me@example.com',
            role,
            isActive: true,
          }),
        );
        expect(Object.keys(res.body as object).sort()).toEqual(PROFILE_FIELDS);
        expect((await row(me.id)).name).toBe('New Name');
        expect((await row(other.id)).name).toBe('Untouched');
        // The change is visible through both "me" endpoints.
        const viaUsers = await http()
          .get('/users/me')
          .set(bearer(me.accessToken))
          .expect(200);
        expect(viaUsers.body.name).toBe('New Name');
        const viaAuth = await http()
          .get('/auth/me')
          .set(bearer(me.accessToken))
          .expect(200);
        expect(viaAuth.body.name).toBe('New Name');
      },
    );

    it.each([
      ['an empty body', {}],
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['a non-string name', { name: 42 }],
      ['a null name', { name: null }],
      ['an over-long name', { name: 'n'.repeat(101) }],
    ])('rejects %s', async (_label, body) => {
      const me = await staff();
      await patchMe(me.accessToken, body).expect(400);
      expect((await row(me.id)).name).toBe('Test User');
    });

    it.each([
      ['role', { role: 'ADMIN' }],
      ['isActive', { isActive: false }],
      ['email', { email: 'evil@example.com' }],
      ['emailVerifiedAt', { emailVerifiedAt: '2020-01-01T00:00:00Z' }],
      ['passwordHash', { passwordHash: 'x' }],
      ['id', { id: UNKNOWN_ID }],
      ['createdAt', { createdAt: '2000-01-01T00:00:00Z' }],
      ['deletedAt', { deletedAt: null }],
    ])(
      'refuses to mass-assign %s, even next to a valid name',
      async (_f, extra) => {
        const me = await staff();
        const before = await row(me.id);

        await patchMe(me.accessToken, { name: 'Sneaky', ...extra }).expect(400);

        const after = await row(me.id);
        expect(after).toEqual(before);
        expect(after.role).toBe('STAFF');
      },
    );

    it('requires authentication and a verified email', async () => {
      await http().patch('/users/me').send({ name: 'X' }).expect(401);

      const unverified = await account('new@example.com', 'STAFF', {
        verified: false,
      });
      const res = await patchMe(unverified.accessToken, {
        name: 'X',
      }).expect(403);
      expect(res.body.message).toBe('Email verification required');
      expect((await row(unverified.id)).name).toBe('Test User');
    });

    it('is not captured by PATCH /users/:id', async () => {
      // If "me" reached the :id route, ParseUUIDPipe would answer 400 (or 403 for staff).
      const me = await staff();
      await patchMe(me.accessToken, { name: 'Routed' }).expect(200);
    });
  });

  describe('access control on administrative routes', () => {
    type Call = (id: string) => request.Test;
    const routes: [string, Call][] = [
      [
        'PATCH /users/:id',
        (id) => http().patch(`/users/${id}`).send({ name: 'X' }),
      ],
      [
        'PATCH /users/:id/active',
        (id) => http().patch(`/users/${id}/active`).send({ isActive: false }),
      ],
      [
        'PATCH /users/:id/role',
        (id) => http().patch(`/users/${id}/role`).send({ role: 'ADMIN' }),
      ],
      ['DELETE /users/:id', (id) => http().delete(`/users/${id}`)],
    ];

    it.each(routes)('%s requires authentication', async (_name, call) => {
      await call(UNKNOWN_ID).expect(401);
      await call(UNKNOWN_ID).set(bearer('not-a-jwt')).expect(401);
    });

    it.each(routes)(
      '%s is forbidden to staff and changes nothing',
      async (_n, call) => {
        const caller = await staff();
        const victim = await createUser(ctx.prisma, {
          email: 'victim@example.com',
          name: 'Victim',
        });
        const before = await row(victim.id);

        await call(victim.id).set(bearer(caller.accessToken)).expect(403);
        // Staff cannot use these routes on themselves either (privilege escalation).
        await call(caller.id).set(bearer(caller.accessToken)).expect(403);

        expect(await row(victim.id)).toEqual(before);
        const self = await row(caller.id);
        expect(self.role).toBe('STAFF');
        expect(self.deletedAt).toBeNull();
      },
    );

    it.each(routes)(
      '%s is blocked for an unverified admin',
      async (_n, call) => {
        const unverified = await account('admin@example.com', 'ADMIN', {
          verified: false,
        });
        const res = await call(UNKNOWN_ID)
          .set(bearer(unverified.accessToken))
          .expect(403);
        expect(res.body.message).toBe('Email verification required');
      },
    );

    it.each(routes)(
      '%s rejects a malformed id before touching the database',
      async (_n, call) => {
        const a = await admin();
        await call('not-a-uuid').set(bearer(a.accessToken)).expect(400);
      },
    );

    it.each(routes)('%s returns 404 for an unknown user', async (_n, call) => {
      const a = await admin();
      await call(UNKNOWN_ID).set(bearer(a.accessToken)).expect(404);
    });
  });

  describe('PATCH /users/:id', () => {
    it('lets an admin rename another user and returns only allowlisted fields', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });

      const res = await http()
        .patch(`/users/${target.id}`)
        .set(bearer(a.accessToken))
        .send({ name: ' Renamed ' })
        .expect(200);

      expect(res.body.name).toBe('Renamed');
      expect(Object.keys(res.body as object).sort()).toEqual(PROFILE_FIELDS);
      expect((await row(target.id)).role).toBe('STAFF');
    });

    it.each([
      ['email', { email: 'x@example.com' }],
      ['passwordHash', { passwordHash: 'x' }],
      ['emailVerifiedAt', { emailVerifiedAt: '2020-01-01T00:00:00Z' }],
      ['deletedAt', { deletedAt: null }],
      ['createdAt', { createdAt: '2000-01-01T00:00:00Z' }],
    ])('refuses to mass-assign %s', async (_field, extra) => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      const before = await row(target.id);

      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(a.accessToken))
        .send({ name: 'Sneaky', ...extra })
        .expect(400);
      expect(await row(target.id)).toEqual(before);
    });
  });

  describe('PATCH /users/:id/active', () => {
    const setActive = (token: string, id: string, body: object) =>
      http().patch(`/users/${id}/active`).set(bearer(token)).send(body);

    it('deactivation ends every session of that user, and only theirs', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      const s1 = await login(ctx.app, 't@example.com');
      const s2 = await login(ctx.app, 't@example.com');
      const bystander = await staff('bystander@example.com');
      expect(await liveSessions(target.id)).toBe(2);

      const res = await setActive(a.accessToken, target.id, {
        isActive: false,
      }).expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({ id: target.id, isActive: false }),
      );
      expect(Object.keys(res.body as object).sort()).toEqual(PROFILE_FIELDS);
      for (const session of [s1, s2]) {
        await expectLockedOut(session, 't@example.com');
      }
      const sessions = await ctx.prisma.session.findMany({
        where: { userId: target.id },
      });
      expect(sessions).toHaveLength(2);
      for (const s of sessions) {
        expect(s.revokedAt).not.toBeNull();
        expect(s.revokedReason).toBe('ACCOUNT_DISABLED');
      }
      // Nobody else is signed out.
      await http()
        .get('/users/me')
        .set(bearer(bystander.accessToken))
        .expect(200);
      expect(await liveSessions(bystander.id)).toBe(1);
    });

    it('reactivation lets the user sign in again but does not restore old sessions', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      const old = await login(ctx.app, 't@example.com');

      await setActive(a.accessToken, target.id, { isActive: false }).expect(
        200,
      );
      await setActive(a.accessToken, target.id, { isActive: true }).expect(200);

      // The pre-deactivation access token and refresh cookie stay dead.
      await http().get('/users/me').set(bearer(old.accessToken)).expect(401);
      await refresh(old).expect(401);
      expect(await liveSessions(target.id)).toBe(0);

      const fresh = await login(ctx.app, 't@example.com');
      await http().get('/users/me').set(bearer(fresh.accessToken)).expect(200);
      await http().get('/users/me').set(bearer(old.accessToken)).expect(401);
    });

    it('also revokes a session that slipped in while the account was disabled', async () => {
      // A sign-in can pass its isActive check, then commit its session just after a
      // deactivation. Simulate that leftover session directly.
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      await setActive(a.accessToken, target.id, { isActive: false }).expect(
        200,
      );
      const ghost = await ctx.prisma.session.create({
        data: {
          userId: target.id,
          refreshTokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      expect(await liveSessions(target.id)).toBe(1);

      await setActive(a.accessToken, target.id, { isActive: true }).expect(200);

      expect(await liveSessions(target.id)).toBe(0);
      const swept = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: ghost.id },
      });
      expect(swept.revokedReason).toBe('ACCOUNT_DISABLED');
    });

    it('is idempotent', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      for (const isActive of [false, false, true, true]) {
        const res = await setActive(a.accessToken, target.id, {
          isActive,
        }).expect(200);
        expect(res.body.isActive).toBe(isActive);
      }
    });

    it('stops an admin deactivating their own account', async () => {
      await admin('other-admin@example.com');
      const a = await admin();

      await setActive(a.accessToken, a.id, { isActive: false }).expect(403);

      expect((await row(a.id)).isActive).toBe(true);
      await http().get('/users/me').set(bearer(a.accessToken)).expect(200);
      // Re-asserting "active" on yourself is harmless.
      await setActive(a.accessToken, a.id, { isActive: true }).expect(200);
    });

    it('allows deactivating one admin while another remains', async () => {
      const a = await admin();
      const b = await admin('b@example.com');

      await setActive(a.accessToken, b.id, { isActive: false }).expect(200);

      expect(await activeAdmins()).toBe(1);
      await expectLockedOut(b, 'b@example.com');
      // The remaining admin is now the last one and cannot remove itself any way.
      await setActive(a.accessToken, a.id, { isActive: false }).expect(403);
      expect(await activeAdmins()).toBe(1);
    });

    it.each([
      ['an empty body', {}],
      ['a string status', { isActive: 'false' }],
      ['a numeric status', { isActive: 0 }],
      ['a null status', { isActive: null }],
      ['an extra role field', { isActive: false, role: 'STAFF' }],
      ['an extra name field', { isActive: false, name: 'X' }],
      ['a status alias', { status: 'inactive' }],
    ])('rejects %s', async (_label, body) => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      const before = await row(target.id);

      await setActive(a.accessToken, target.id, body).expect(400);
      expect(await row(target.id)).toEqual(before);
    });
  });

  describe('PATCH /users/:id/role', () => {
    const setRole = (token: string, id: string, body: object) =>
      http().patch(`/users/${id}/role`).set(bearer(token)).send(body);

    it('applies a promotion to the target immediately, using their existing token', async () => {
      const a = await admin();
      const target = await staff('t@example.com');
      await http().get('/users').set(bearer(target.accessToken)).expect(403);

      const res = await setRole(a.accessToken, target.id, {
        role: 'ADMIN',
      }).expect(200);
      expect(res.body.role).toBe('ADMIN');
      expect(Object.keys(res.body as object).sort()).toEqual(PROFILE_FIELDS);

      // Same token as before the change: no re-login needed.
      await http().get('/users').set(bearer(target.accessToken)).expect(200);
      const me = await http()
        .get('/users/me')
        .set(bearer(target.accessToken))
        .expect(200);
      expect(me.body.role).toBe('ADMIN');
    });

    it('applies a demotion immediately and keeps the user signed in', async () => {
      const a = await admin();
      const target = await account('t@example.com', 'ADMIN');
      await http().get('/users').set(bearer(target.accessToken)).expect(200);

      await setRole(a.accessToken, target.id, { role: 'STAFF' }).expect(200);

      await http().get('/users').set(bearer(target.accessToken)).expect(403);
      await setRole(target.accessToken, a.id, { role: 'STAFF' }).expect(403);
      const me = await http()
        .get('/users/me')
        .set(bearer(target.accessToken))
        .expect(200);
      expect(me.body.role).toBe('STAFF');
      // Authentication itself is untouched: the refresh session survives.
      expect(await liveSessions(target.id)).toBe(1);
      await refresh(target).expect(200);
    });

    it('works because access tokens carry no role claim to go stale', async () => {
      const target = await staff('t@example.com');
      const payload = JSON.parse(
        Buffer.from(target.accessToken.split('.')[1], 'base64url').toString(),
      ) as Record<string, unknown>;

      expect(Object.keys(payload).sort()).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'sid', 'sub'].sort(),
      );
      expect(payload).not.toHaveProperty('role');
    });

    it('stops an admin demoting themselves, but allows re-asserting their own role', async () => {
      await admin('other-admin@example.com');
      const a = await admin();

      await setRole(a.accessToken, a.id, { role: 'STAFF' }).expect(403);
      expect((await row(a.id)).role).toBe('ADMIN');

      await setRole(a.accessToken, a.id, { role: 'ADMIN' }).expect(200);
    });

    it('does not let staff promote themselves or anyone else', async () => {
      const s = await staff();
      const other = await createUser(ctx.prisma, { email: 'o@example.com' });

      await setRole(s.accessToken, s.id, { role: 'ADMIN' }).expect(403);
      await setRole(s.accessToken, other.id, { role: 'ADMIN' }).expect(403);

      expect((await row(s.id)).role).toBe('STAFF');
      expect((await row(other.id)).role).toBe('STAFF');
    });

    it('lets the only other admin demote an admin, leaving one', async () => {
      const a = await admin();
      const b = await admin('b@example.com');

      await setRole(a.accessToken, b.id, { role: 'STAFF' }).expect(200);

      expect(await activeAdmins()).toBe(1);
      // The sole remaining admin cannot step down.
      await setRole(a.accessToken, a.id, { role: 'STAFF' }).expect(403);
      expect(await activeAdmins()).toBe(1);
    });

    it.each([
      ['an empty body', {}],
      ['an unknown role', { role: 'OWNER' }],
      ['a lowercase role', { role: 'admin' }],
      ['a null role', { role: null }],
      ['an array role', { role: ['ADMIN'] }],
      ['an extra status field', { role: 'ADMIN', isActive: false }],
      ['an extra name field', { role: 'ADMIN', name: 'X' }],
    ])('rejects %s', async (_label, body) => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      const before = await row(target.id);

      await setRole(a.accessToken, target.id, body).expect(400);
      expect(await row(target.id)).toEqual(before);
    });
  });

  describe('DELETE /users/:id (soft delete)', () => {
    const remove = (token: string, id: string) =>
      http().delete(`/users/${id}`).set(bearer(token));

    it('removes the account from the API, keeps the row, and locks the user out', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, {
        email: 't@example.com',
        name: 'Doomed',
      });
      const session = await login(ctx.app, 't@example.com');
      const bystander = await createUser(ctx.prisma, {
        email: 'b@example.com',
      });

      const res = await remove(a.accessToken, target.id).expect(204);
      expect(res.text).toBe('');

      // Retained, not erased: identity is kept for any record that references it.
      const kept = await row(target.id);
      expect(kept.deletedAt).not.toBeNull();
      expect(kept.isActive).toBe(false);
      expect(kept.email).toBe('t@example.com');
      expect(kept.name).toBe('Doomed');

      // Gone from every users endpoint.
      await http()
        .get(`/users/${target.id}`)
        .set(bearer(a.accessToken))
        .expect(404);
      const list = await http()
        .get('/users')
        .set(bearer(a.accessToken))
        .expect(200);
      const emails = (list.body.data as { email: string }[]).map(
        (u) => u.email,
      );
      expect(emails.sort()).toEqual(['admin@example.com', 'b@example.com']);
      expect(list.body.meta.total).toBe(2);
      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(a.accessToken))
        .send({ name: 'Zombie' })
        .expect(404);
      await http()
        .patch(`/users/${target.id}/active`)
        .set(bearer(a.accessToken))
        .send({ isActive: true })
        .expect(404);
      await http()
        .patch(`/users/${target.id}/role`)
        .set(bearer(a.accessToken))
        .send({ role: 'ADMIN' })
        .expect(404);
      await remove(a.accessToken, target.id).expect(404);
      expect((await row(target.id)).isActive).toBe(false);

      // Cannot authenticate or reuse anything.
      await expectLockedOut(session, 't@example.com');
      expect(await liveSessions(target.id)).toBe(0);
      // Session history is kept (revoked), never cascaded away.
      const sessions = await ctx.prisma.session.findMany({
        where: { userId: target.id },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedReason).toBe('ACCOUNT_DISABLED');

      // Other users are unaffected.
      expect((await row(bystander.id)).deletedAt).toBeNull();
    });

    it('cannot be undone by reactivating through the API or the database', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      await remove(a.accessToken, target.id).expect(204);

      // The CHECK constraint refuses a deleted-but-active row outright.
      await expect(
        ctx.prisma.user.update({
          where: { id: target.id },
          data: { isActive: true },
        }),
      ).rejects.toThrow('User_deleted_not_active_check');
      const after = await row(target.id);
      expect(after.isActive).toBe(false);
      expect(after.deletedAt).not.toBeNull();
    });

    it('voids outstanding invitation and reset links but keeps the token rows', async () => {
      const a = await admin();
      const invited = await http()
        .post('/users')
        .set(bearer(a.accessToken))
        .send({ name: 'Invitee', email: 'invitee@example.com' })
        .expect(201);
      const id = invited.body.user.id as string;
      const link = tokenFrom(ctx.mail.to('invitee@example.com')[0]);

      await remove(a.accessToken, id).expect(204);

      await http()
        .post('/auth/reset-password')
        .send({ token: link, password: 'Brand-New-Passw0rd' })
        .expect(400);
      expect((await row(id)).passwordHash).toBeNull();
      expect(
        await ctx.prisma.passwordResetToken.count({
          where: { userId: id, usedAt: null },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.passwordResetToken.count({ where: { userId: id } }),
      ).toBe(1);

      // A "forgot password" request for the deleted address issues nothing.
      await http()
        .post('/auth/forgot-password')
        .send({ email: 'invitee@example.com' })
        .expect(202);
      expect(
        await ctx.prisma.passwordResetToken.count({
          where: { userId: id, usedAt: null },
        }),
      ).toBe(0);
    });

    it('keeps the email reserved, so a deleted account cannot be silently duplicated', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      await remove(a.accessToken, target.id).expect(204);

      const res = await http()
        .post('/users')
        .set(bearer(a.accessToken))
        .send({ name: 'Again', email: 't@example.com' })
        .expect(409);
      expect(res.body.message).toBe('A user with this email already exists');
    });

    it('stops an admin deleting their own account', async () => {
      await admin('other-admin@example.com');
      const a = await admin();

      await remove(a.accessToken, a.id).expect(403);

      expect((await row(a.id)).deletedAt).toBeNull();
      await http().get('/users/me').set(bearer(a.accessToken)).expect(200);
    });

    it('protects the last active admin', async () => {
      const a = await admin();
      const b = await admin('b@example.com');

      // One of two admins may be deleted...
      await remove(a.accessToken, b.id).expect(204);
      expect(await activeAdmins()).toBe(1);

      // ...but the last one cannot remove itself, however it asks.
      await remove(a.accessToken, a.id).expect(403);
      await http()
        .patch(`/users/${a.id}/active`)
        .set(bearer(a.accessToken))
        .send({ isActive: false })
        .expect(403);
      await http()
        .patch(`/users/${a.id}/role`)
        .set(bearer(a.accessToken))
        .send({ role: 'STAFF' })
        .expect(403);
      expect(await activeAdmins()).toBe(1);
    });

    it('does not count an inactive admin toward the minimum, and may delete one', async () => {
      const a = await admin();
      const dormant = await createUser(ctx.prisma, {
        email: 'dormant@example.com',
        role: 'ADMIN',
        active: false,
      });

      await remove(a.accessToken, dormant.id).expect(204);
      expect((await row(dormant.id)).deletedAt).not.toBeNull();
      expect(await activeAdmins()).toBe(1);
    });
  });

  describe('concurrent operations that remove admin access', () => {
    type Op = (token: string, id: string) => request.Test;
    const ops: Record<string, Op> = {
      deactivate: (token, id) =>
        http()
          .patch(`/users/${id}/active`)
          .set(bearer(token))
          .send({ isActive: false }),
      demote: (token, id) =>
        http()
          .patch(`/users/${id}/role`)
          .set(bearer(token))
          .send({ role: 'STAFF' }),
      'combined update': (token, id) =>
        http().patch(`/users/${id}`).set(bearer(token)).send({ role: 'STAFF' }),
      delete: (token, id) => http().delete(`/users/${id}`).set(bearer(token)),
    };
    const pairs = Object.keys(ops).flatMap((first) =>
      Object.keys(ops).map((second) => [first, second] as const),
    );

    it.each(pairs)(
      'two admins that "%s" and "%s" each other at once never leave the system without an admin',
      async (first, second) => {
        const a = await admin('a@example.com');
        const b = await admin('b@example.com');

        const results = await Promise.all([
          ops[first](a.accessToken, b.id),
          ops[second](b.accessToken, a.id),
        ]);

        const succeeded = results.filter((r) => r.status < 300);
        const refused = results.filter((r) => r.status >= 300);
        expect(succeeded).toHaveLength(1);
        expect(refused).toHaveLength(1);
        // How the loser is turned away depends on when it lost: 401 if the winner
        // had already disabled/deleted its account before the request authenticated,
        // 403 if it was demoted or re-checked as no longer an admin under the lock,
        // 409 if the last-admin rule fired.
        expect([401, 403, 409]).toContain(refused[0].status);
        expect(await activeAdmins()).toBe(1);
      },
    );

    it('keeps an admin when three admins each remove the next in a ring', async () => {
      const a = await admin('a@example.com');
      const b = await admin('b@example.com');
      const c = await admin('c@example.com');

      const results = await Promise.all([
        ops.deactivate(a.accessToken, b.id),
        ops.deactivate(b.accessToken, c.id),
        ops.deactivate(c.accessToken, a.id),
      ]);

      expect(results.some((r) => r.status < 300)).toBe(true);
      expect(await activeAdmins()).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect([200, 204, 401, 403, 409]).toContain(r.status);
      }
    });

    it('does not let a just-demoted admin finish an in-flight administrative action', async () => {
      const a = await admin('a@example.com');
      const b = await admin('b@example.com');
      const victim = await createUser(ctx.prisma, { email: 'v@example.com' });

      // B's request already passed authentication as an admin; A demotes B
      // first, then B's action reaches the service.
      await http()
        .patch(`/users/${b.id}/role`)
        .set(bearer(a.accessToken))
        .send({ role: 'STAFF' })
        .expect(200);
      const staleActor = {
        ...(await row(b.id)),
        role: 'ADMIN' as const, // what the guard saw before the demotion
        sessionId: b.sessionId,
      };
      const outcome = await ctx.app
        .get(UsersService)
        .remove(staleActor, victim.id)
        .then(
          () => 'allowed',
          (error: { status?: number }) => error.status,
        );

      expect(outcome).toBe(403);
      expect((await row(victim.id)).deletedAt).toBeNull();
    });

    it('leaves no live session behind when deactivation and reactivation race', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });
      await login(ctx.app, 't@example.com');
      await login(ctx.app, 't@example.com');

      await Promise.all([
        http()
          .patch(`/users/${target.id}/active`)
          .set(bearer(a.accessToken))
          .send({ isActive: false }),
        http()
          .patch(`/users/${target.id}/active`)
          .set(bearer(a.accessToken))
          .send({ isActive: true }),
      ]);

      // Whichever order they ran in, the earlier sessions are gone.
      expect(await liveSessions(target.id)).toBe(0);
    });

    it('serializes concurrent deletes of the same user: one succeeds, the rest are 404', async () => {
      const a = await admin();
      const target = await createUser(ctx.prisma, { email: 't@example.com' });

      const results = await Promise.all(
        [0, 1, 2].map(() =>
          http().delete(`/users/${target.id}`).set(bearer(a.accessToken)),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([204, 404, 404]);
      expect((await row(target.id)).deletedAt).not.toBeNull();
    });
  });
});
