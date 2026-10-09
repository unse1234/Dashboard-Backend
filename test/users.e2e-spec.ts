import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import { sha256 } from '../src/common/crypto.util';
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
  waitForMail,
  type TestContext,
} from './helpers';

/** Emails from a paginated /users response, in order. */
const emailsOf = (res: { body: unknown }): string[] =>
  (res.body as { data: { email: string }[] }).data.map((u) => u.email);

describe('Users and invitations (e2e)', () => {
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
    jest.restoreAllMocks();
  });

  async function adminToken(email = 'admin@example.com') {
    await createUser(ctx.prisma, { email, role: 'ADMIN', name: 'Admin' });
    return (await login(ctx.app, email)).accessToken;
  }
  async function staffToken(email = 'staff@example.com') {
    await createUser(ctx.prisma, { email, role: 'STAFF' });
    return (await login(ctx.app, email)).accessToken;
  }

  describe('access control', () => {
    it('requires authentication on every users route', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      await http().get('/users').expect(401);
      await http().get('/users/me').expect(401);
      await http().get(`/users/${id}`).expect(401);
      await http()
        .post('/users')
        .send({ name: 'X', email: 'x@example.com' })
        .expect(401);
      await http().patch(`/users/${id}`).send({ name: 'X' }).expect(401);
    });

    it('forbids staff from every users route', async () => {
      const token = await staffToken();
      const id = '00000000-0000-4000-8000-000000000000';
      await http().get('/users').set(bearer(token)).expect(403);
      await http().get(`/users/${id}`).set(bearer(token)).expect(403);
      await http()
        .post('/users')
        .set(bearer(token))
        .send({ name: 'X', email: 'x@example.com' })
        .expect(403);
      await http()
        .patch(`/users/${id}`)
        .set(bearer(token))
        .send({ name: 'X' })
        .expect(403);
    });

    it('blocks an admin whose email is not verified', async () => {
      await createUser(ctx.prisma, {
        email: 'admin@example.com',
        role: 'ADMIN',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'admin@example.com');
      const res = await http()
        .get('/users')
        .set(bearer(accessToken))
        .expect(403);
      expect(res.body.message).toBe('Email verification required');
    });
  });

  describe('GET /users/me', () => {
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

    it.each(['ADMIN', 'STAFF'] as const)(
      "returns the caller's own profile to a %s, and only allowlisted fields",
      async (role) => {
        const created = await createUser(ctx.prisma, {
          email: 'me@example.com',
          name: 'Me Myself',
          role,
        });
        await createUser(ctx.prisma, { email: 'someone-else@example.com' });
        const { accessToken } = await login(ctx.app, 'me@example.com');

        const res = await http()
          .get('/users/me')
          .set(bearer(accessToken))
          .expect(200);

        expect(res.body).toEqual(
          expect.objectContaining({
            id: created.id,
            email: 'me@example.com',
            name: 'Me Myself',
            role,
            isActive: true,
          }),
        );
        // Exact key set: anything new on the User model must be opted in.
        expect(Object.keys(res.body as object).sort()).toEqual(PROFILE_FIELDS);
        expect(JSON.stringify(res.body)).not.toMatch(
          /passwordHash|argon2|sessionId|refresh/i,
        );
      },
    );

    it('is not captured by the :id route', async () => {
      // If `me` were matched as an id, ParseUUIDPipe would answer 400 (or an
      // admin would get 404), never the caller's own record.
      const token = await adminToken();
      const res = await http().get('/users/me').set(bearer(token)).expect(200);
      expect(res.body.email).toBe('admin@example.com');
    });

    it('rejects a missing, malformed or forged token', async () => {
      await http().get('/users/me').expect(401);
      await http().get('/users/me').set(bearer('not-a-jwt')).expect(401);
      await http()
        .get('/users/me')
        .set({ Authorization: 'Basic abc' })
        .expect(401);
    });

    it('follows the platform policy for unverified accounts', async () => {
      await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'new@example.com');
      const res = await http()
        .get('/users/me')
        .set(bearer(accessToken))
        .expect(403);
      expect(res.body.message).toBe('Email verification required');
      // Unverified users keep self-service through /auth/me.
      await http().get('/auth/me').set(bearer(accessToken)).expect(200);
    });

    it('stops working as soon as the account is deactivated', async () => {
      const token = await adminToken();
      const target = await createUser(ctx.prisma, {
        email: 'target@example.com',
      });
      const session = await login(ctx.app, 'target@example.com');
      await http()
        .get('/users/me')
        .set(bearer(session.accessToken))
        .expect(200);

      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send({ isActive: false })
        .expect(200);
      await http()
        .get('/users/me')
        .set(bearer(session.accessToken))
        .expect(401);
    });
  });

  describe('attempts to create unauthorized admin accounts', () => {
    it('rejects an unauthenticated request asking for the ADMIN role', async () => {
      await http()
        .post('/users')
        .send({ name: 'Mallory', email: 'mallory@example.com', role: 'ADMIN' })
        .expect(401);
      await http()
        .post('/auth/login')
        .send({ email: 'mallory@example.com', password: TEST_PASSWORD })
        .expect(401);
      expect(await ctx.prisma.user.count()).toBe(0);
    });

    it('rejects a staff member asking for the ADMIN role', async () => {
      const token = await staffToken();
      await http()
        .post('/users')
        .set(bearer(token))
        .send({ name: 'Mallory', email: 'mallory@example.com', role: 'ADMIN' })
        .expect(403);
      expect(
        await ctx.prisma.user.count({
          where: { email: 'mallory@example.com' },
        }),
      ).toBe(0);
    });

    it('has no public registration route', async () => {
      for (const path of [
        '/auth/register',
        '/auth/signup',
        '/users/register',
      ]) {
        const res = await http().post(path).send({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: TEST_PASSWORD,
          role: 'ADMIN',
        });
        expect([401, 404]).toContain(res.status);
      }
      expect(await ctx.prisma.user.count()).toBe(0);
    });

    it('cannot promote oneself, directly or by mass assignment', async () => {
      await createUser(ctx.prisma, {
        email: 'staff@example.com',
        role: 'STAFF',
      });
      const { accessToken } = await login(ctx.app, 'staff@example.com');
      const me = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'staff@example.com' },
      });

      await http()
        .patch(`/users/${me.id}`)
        .set(bearer(accessToken))
        .send({ role: 'ADMIN' })
        .expect(403);
      const after = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: me.id },
      });
      expect(after.role).toBe('STAFF');
    });
  });

  describe('POST /users (invitation)', () => {
    it('creates a passwordless account and emails a set-password link', async () => {
      const token = await adminToken();

      const res = await http()
        .post('/users')
        .set(bearer(token))
        .send({ name: '  Sam Staff ', email: ' Sam@Example.COM ' })
        .expect(201);

      expect(res.body).toEqual({
        invitationSent: true,
        user: expect.objectContaining({
          name: 'Sam Staff',
          email: 'sam@example.com',
          role: 'STAFF',
          isActive: true,
          emailVerifiedAt: null,
          lastLoginAt: null,
        }),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|token/i);

      const row = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'sam@example.com' },
      });
      expect(row.passwordHash).toBeNull();

      const [mail] = ctx.mail.to('sam@example.com');
      expect(mail.text).toContain('/reset-password?token=');
      const stored = await ctx.prisma.passwordResetToken.findFirstOrThrow({
        where: { userId: row.id },
      });
      expect(stored.tokenHash).toBe(sha256(tokenFrom(mail)));
      // Invitations live longer than resets: 72 hours.
      expect(
        stored.expiresAt.getTime() - stored.createdAt.getTime(),
      ).toBeGreaterThan(71 * 3_600_000);
    });

    it('lets the invitee set a password, which also verifies the email, then sign in', async () => {
      const token = await adminToken();
      await http()
        .post('/users')
        .set(bearer(token))
        .send({ name: 'Sam', email: 'sam@example.com' })
        .expect(201);

      await http()
        .post('/auth/login')
        .send({ email: 'sam@example.com', password: TEST_PASSWORD })
        .expect(401);

      const invite = tokenFrom(ctx.mail.to('sam@example.com')[0]);
      await http()
        .post('/auth/reset-password')
        .send({ token: invite, password: 'Sams-Own-Passw0rd' })
        .expect(200);

      const signedIn = await http()
        .post('/auth/login')
        .send({ email: 'sam@example.com', password: 'Sams-Own-Passw0rd' })
        .expect(200);
      expect(signedIn.body.user.emailVerifiedAt).not.toBeNull();
      expect(signedIn.body.user.role).toBe('STAFF');

      // Verified, but still staff: no access to user management.
      await http()
        .get('/users')
        .set(bearer((signedIn.body as { accessToken: string }).accessToken))
        .expect(403);
    });

    it('lets an admin invite another admin', async () => {
      const token = await adminToken();
      const res = await http()
        .post('/users')
        .set(bearer(token))
        .send({
          name: 'Second Admin',
          email: 'admin2@example.com',
          role: 'ADMIN',
        })
        .expect(201);
      expect(res.body.user.role).toBe('ADMIN');
    });

    it('returns 409 for a duplicate email regardless of case', async () => {
      const token = await adminToken();
      await createUser(ctx.prisma, { email: 'taken@example.com' });

      for (const email of [
        'taken@example.com',
        'TAKEN@Example.com',
        ' taken@example.com ',
      ]) {
        const res = await http()
          .post('/users')
          .set(bearer(token))
          .send({ name: 'Dup', email })
          .expect(409);
        expect(res.body.message).toBe('A user with this email already exists');
      }
      expect(ctx.mail.to('taken@example.com')).toHaveLength(0);
    });

    it.each([
      [
        'a client-supplied password',
        { name: 'X', email: 'x@example.com', password: 'Whatever-1234' },
      ],
      [
        'an unknown role',
        { name: 'X', email: 'x@example.com', role: 'SUPERUSER' },
      ],
      [
        'a lowercase role',
        { name: 'X', email: 'x@example.com', role: 'admin' },
      ],
      ['a missing name', { email: 'x@example.com' }],
      ['an empty name', { name: '   ', email: 'x@example.com' }],
      ['an invalid email', { name: 'X', email: 'nope' }],
      ['an over-long name', { name: 'n'.repeat(101), email: 'x@example.com' }],
      [
        'privileged fields',
        {
          name: 'X',
          email: 'x@example.com',
          isActive: false,
          emailVerifiedAt: '2020-01-01',
        },
      ],
    ])('rejects %s', async (_label, body) => {
      const token = await adminToken();
      await http().post('/users').set(bearer(token)).send(body).expect(400);
      expect(
        await ctx.prisma.user.count({ where: { email: 'x@example.com' } }),
      ).toBe(0);
    });

    it('keeps the account and reports failure when the email cannot be sent', async () => {
      const token = await adminToken();
      jest
        .spyOn(ctx.mail, 'send')
        .mockRejectedValueOnce(new Error('smtp down'));

      const res = await http()
        .post('/users')
        .set(bearer(token))
        .send({ name: 'Sam', email: 'sam@example.com' })
        .expect(201);
      expect(res.body.invitationSent).toBe(false);
      expect(
        await ctx.prisma.user.count({ where: { email: 'sam@example.com' } }),
      ).toBe(1);

      // The invitee can still get a link through "forgot password" once the
      // per-account email cooldown (which the invitation itself started) has passed.
      await ctx.prisma.passwordResetToken.updateMany({
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
      await http()
        .post('/auth/forgot-password')
        .send({ email: 'sam@example.com' })
        .expect(202);
      await waitForMail(ctx.mail, 'sam@example.com');
    });
  });

  describe('GET /users', () => {
    beforeEach(async () => {
      await createUser(ctx.prisma, {
        email: 'admin@example.com',
        role: 'ADMIN',
        name: 'Alice Admin',
      });
      await createUser(ctx.prisma, {
        email: 'bob@example.com',
        name: 'Bob Builder',
      });
      await createUser(ctx.prisma, {
        email: 'carol@example.com',
        name: 'Carol Clark',
        active: false,
      });
      await createUser(ctx.prisma, {
        email: 'dave@example.com',
        name: 'Dave Dunn',
      });
    });

    const list = async (query = '') => {
      const { accessToken } = await login(ctx.app, 'admin@example.com');
      return http().get(`/users${query}`).set(bearer(accessToken)).expect(200);
    };

    it('paginates and never exposes credentials', async () => {
      const res = await list('?pageSize=2&page=2');
      expect(res.body.meta).toEqual({
        page: 2,
        pageSize: 2,
        total: 4,
        totalPages: 2,
      });
      expect(res.body.data).toHaveLength(2);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/i);
    });

    it('filters by search text, role and status', async () => {
      const byName = await list('?search=builder');
      expect(emailsOf(byName)).toEqual(['bob@example.com']);

      const byEmail = await list('?search=CAROL@');
      expect(byEmail.body.meta.total).toBe(1);

      const admins = await list('?role=ADMIN');
      expect(admins.body.meta.total).toBe(1);

      const inactive = await list('?isActive=false');
      expect(emailsOf(inactive)).toEqual(['carol@example.com']);

      const active = await list('?isActive=true');
      expect(active.body.meta.total).toBe(3);
    });

    it('treats search text literally, not as a pattern', async () => {
      const res = await list('?search=%25');
      expect(res.body.meta.total).toBe(0);
    });

    it('matches LIKE metacharacters in names literally and case-insensitively', async () => {
      await createUser(ctx.prisma, {
        email: 'promo@example.com',
        name: '100%_Real',
      });
      await createUser(ctx.prisma, {
        email: 'plain@example.com',
        name: '100 Real',
      });

      // %25 = "%", %5F = "_": must match only the name that contains them.
      const res = await list('?search=100%25%5Freal');
      expect(emailsOf(res)).toEqual(['promo@example.com']);
    });

    it('lists newest first, breaking createdAt ties by id, without skipping or repeating rows across pages', async () => {
      const rows = await ctx.prisma.user.findMany({
        select: { id: true, email: true },
      });
      const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.id]));
      const day = (n: number) => new Date(Date.UTC(2026, 0, n));
      await ctx.prisma.user.update({
        where: { id: byEmail['admin@example.com'] },
        data: { createdAt: day(1) },
      });
      await ctx.prisma.user.update({
        where: { id: byEmail['bob@example.com'] },
        data: { createdAt: day(3) },
      });
      // carol and dave share a timestamp: the order must still be stable.
      for (const email of ['carol@example.com', 'dave@example.com']) {
        await ctx.prisma.user.update({
          where: { id: byEmail[email] },
          data: { createdAt: day(2) },
        });
      }
      const tied = ['carol@example.com', 'dave@example.com'].sort((a, b) =>
        byEmail[a].localeCompare(byEmail[b]),
      );
      const expected = ['bob@example.com', ...tied, 'admin@example.com'];

      expect(emailsOf(await list())).toEqual(expected);

      const paged: string[] = [];
      for (const page of [1, 2, 3, 4]) {
        paged.push(...emailsOf(await list(`?pageSize=1&page=${page}`)));
      }
      expect(paged).toEqual(expected);
    });

    it('returns an empty page, with accurate metadata, past the last page', async () => {
      const res = await list('?page=5&pageSize=2');
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toEqual({
        page: 5,
        pageSize: 2,
        total: 4,
        totalPages: 2,
      });
    });

    it('applies filters to both the rows and the total', async () => {
      const res = await list('?isActive=true&pageSize=2&page=1');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({
        page: 1,
        pageSize: 2,
        total: 3,
        totalPages: 2,
      });
    });

    it('answers an enormous page number with an empty page rather than an error', async () => {
      const res = await list('?page=9007199254740991');
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(4);
    });

    it.each([
      '?page=0',
      '?page=abc',
      '?pageSize=0',
      '?pageSize=101',
      '?role=ROOT',
      '?isActive=maybe',
      '?unknown=1',
    ])('rejects invalid query %s', async (query) => {
      const { accessToken } = await login(ctx.app, 'admin@example.com');
      await http().get(`/users${query}`).set(bearer(accessToken)).expect(400);
    });
  });

  describe('GET /users/:id', () => {
    it('returns a user, 404 for unknown ids and 400 for malformed ids', async () => {
      const token = await adminToken();
      const other = await createUser(ctx.prisma, {
        email: 'other@example.com',
      });

      const res = await http()
        .get(`/users/${other.id}`)
        .set(bearer(token))
        .expect(200);
      expect(res.body.email).toBe('other@example.com');
      expect(res.body).not.toHaveProperty('passwordHash');

      await http()
        .get('/users/00000000-0000-4000-8000-000000000000')
        .set(bearer(token))
        .expect(404);
      await http().get('/users/not-a-uuid').set(bearer(token)).expect(400);
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates name and role', async () => {
      const token = await adminToken();
      const target = await createUser(ctx.prisma, {
        email: 'target@example.com',
      });

      const res = await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send({ name: ' New Name ', role: 'ADMIN' })
        .expect(200);
      expect(res.body).toEqual(
        expect.objectContaining({ name: 'New Name', role: 'ADMIN' }),
      );
    });

    it('takes effect for the affected user immediately on role change', async () => {
      const token = await adminToken();
      const target = await createUser(ctx.prisma, {
        email: 'target@example.com',
        role: 'ADMIN',
      });
      const targetSession = await login(ctx.app, 'target@example.com');
      await http()
        .get('/users')
        .set(bearer(targetSession.accessToken))
        .expect(200);

      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send({ role: 'STAFF' })
        .expect(200);
      await http()
        .get('/users')
        .set(bearer(targetSession.accessToken))
        .expect(403);
    });

    it('deactivating a user ends their sessions; reactivating lets them sign in again', async () => {
      const token = await adminToken();
      const target = await createUser(ctx.prisma, {
        email: 'target@example.com',
      });
      const session = await login(ctx.app, 'target@example.com');

      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send({ isActive: false })
        .expect(200);

      await http().get('/auth/me').set(bearer(session.accessToken)).expect(401);
      await http()
        .post('/auth/refresh')
        .set(csrfHeaders)
        .set('Cookie', session.cookie)
        .expect(401);
      await http()
        .post('/auth/login')
        .send({ email: 'target@example.com', password: TEST_PASSWORD })
        .expect(401);
      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(row.revokedReason).toBe('ACCOUNT_DISABLED');

      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send({ isActive: true })
        .expect(200);
      await http()
        .post('/auth/login')
        .send({ email: 'target@example.com', password: TEST_PASSWORD })
        .expect(200);
    });

    it('stops admins changing their own role or status but allows renaming', async () => {
      const token = await adminToken();
      const me = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'admin@example.com' },
      });

      await http()
        .patch(`/users/${me.id}`)
        .set(bearer(token))
        .send({ role: 'STAFF' })
        .expect(403);
      await http()
        .patch(`/users/${me.id}`)
        .set(bearer(token))
        .send({ isActive: false })
        .expect(403);
      await http()
        .patch(`/users/${me.id}`)
        .set(bearer(token))
        .send({ role: 'ADMIN', name: 'Renamed' })
        .expect(200);
      expect(
        (await ctx.prisma.user.findUniqueOrThrow({ where: { id: me.id } }))
          .name,
      ).toBe('Renamed');
    });

    it('cannot leave the system without an admin when two admins demote each other at once', async () => {
      await createUser(ctx.prisma, { email: 'a@example.com', role: 'ADMIN' });
      const b = await createUser(ctx.prisma, {
        email: 'b@example.com',
        role: 'ADMIN',
      });
      const sessionA = await login(ctx.app, 'a@example.com');
      const sessionB = await login(ctx.app, 'b@example.com');
      const a = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'a@example.com' },
      });

      const results = await Promise.all([
        http()
          .patch(`/users/${b.id}`)
          .set(bearer(sessionA.accessToken))
          .send({ role: 'STAFF' }),
        http()
          .patch(`/users/${a.id}`)
          .set(bearer(sessionB.accessToken))
          .send({ role: 'STAFF' }),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect([403, 409]).toContain(
        results.find((r) => r.status !== 200)?.status,
      );
      expect(
        await ctx.prisma.user.count({
          where: { role: 'ADMIN', isActive: true },
        }),
      ).toBe(1);
    });

    it.each([
      ['an empty update', {}],
      ['the email address', { email: 'new@example.com' }],
      ['the password hash', { passwordHash: 'x' }],
      ['email verification', { emailVerifiedAt: '2020-01-01T00:00:00Z' }],
      ['an invalid role', { role: 'OWNER' }],
      ['a non-boolean status', { isActive: 'false' }],
    ])('rejects %s', async (_label, body) => {
      const token = await adminToken();
      const target = await createUser(ctx.prisma, {
        email: 'target@example.com',
      });
      await http()
        .patch(`/users/${target.id}`)
        .set(bearer(token))
        .send(body)
        .expect(400);
    });

    it('returns 404 for unknown users', async () => {
      const token = await adminToken();
      await http()
        .patch('/users/00000000-0000-4000-8000-000000000000')
        .set(bearer(token))
        .send({ name: 'X' })
        .expect(404);
    });
  });

  describe('first-admin bootstrap', () => {
    it('creates the first admin without a password and emails a set-password link', async () => {
      const users = ctx.app.get(UsersService);
      const { user, invitationSent } = await users.bootstrapAdmin({
        name: 'First Admin',
        email: 'root@example.com',
      });
      expect(invitationSent).toBe(true);
      expect(user.role).toBe('ADMIN');

      const row = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(row.passwordHash).toBeNull();

      await http()
        .post('/auth/reset-password')
        .send({
          token: tokenFrom(ctx.mail.to('root@example.com')[0]),
          password: 'Root-Admin-Passw0rd',
        })
        .expect(200);
      const signedIn = await http()
        .post('/auth/login')
        .send({ email: 'root@example.com', password: 'Root-Admin-Passw0rd' })
        .expect(200);
      await http()
        .get('/users')
        .set(bearer((signedIn.body as { accessToken: string }).accessToken))
        .expect(200);
    });

    it('refuses to run while an active admin exists', async () => {
      await createUser(ctx.prisma, {
        email: 'admin@example.com',
        role: 'ADMIN',
      });
      await expect(
        ctx.app
          .get(UsersService)
          .bootstrapAdmin({ name: 'Second', email: 'second@example.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await ctx.prisma.user.count()).toBe(1);
    });

    it('allows recovery when every admin has been deactivated', async () => {
      await createUser(ctx.prisma, {
        email: 'old@example.com',
        role: 'ADMIN',
        active: false,
      });
      const { user } = await ctx.app
        .get(UsersService)
        .bootstrapAdmin({ name: 'Recovery', email: 'recovery@example.com' });
      expect(user.role).toBe('ADMIN');
    });

    it('lets only one of several concurrent bootstraps win', async () => {
      const users = ctx.app.get(UsersService);
      const results = await Promise.allSettled(
        ['a', 'b', 'c'].map((n) =>
          users.bootstrapAdmin({ name: n, email: `${n}@example.com` }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await ctx.prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
    });
  });
});
