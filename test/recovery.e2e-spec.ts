import request from 'supertest';
import { sha256 } from '../src/common/crypto.util';
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

const NEW_PASSWORD = 'Brand-New-Passw0rd';
const GENERIC_FORGOT = {
  message:
    'If an account exists for that email address, a password reset link has been sent.',
};

describe('Password recovery and email verification (e2e)', () => {
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

  /** Requests a reset link and returns the plaintext token from the email. */
  async function requestResetToken(email: string): Promise<string> {
    await http().post('/auth/forgot-password').send({ email }).expect(202);
    const mails = await waitForMail(ctx.mail, email);
    return tokenFrom(mails[mails.length - 1]);
  }

  describe('POST /auth/forgot-password', () => {
    it('answers identically for existing, unknown and disabled accounts', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      await createUser(ctx.prisma, { email: 'off@example.com', active: false });

      const responses = [];
      for (const email of [
        'real@example.com',
        'ghost@example.com',
        'off@example.com',
      ]) {
        responses.push(
          await http()
            .post('/auth/forgot-password')
            .send({ email })
            .expect(202),
        );
      }
      for (const res of responses) expect(res.body).toEqual(GENERIC_FORGOT);

      await waitForMail(ctx.mail, 'real@example.com');
      expect(ctx.mail.sent).toHaveLength(1); // nothing for unknown or disabled accounts
    });

    it('never returns the token and stores only its hash', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const res = await http()
        .post('/auth/forgot-password')
        .send({ email: 'real@example.com' })
        .expect(202);
      const [mail] = await waitForMail(ctx.mail, 'real@example.com');
      const token = tokenFrom(mail);

      expect(JSON.stringify(res.body)).not.toContain(token);
      const row = await ctx.prisma.passwordResetToken.findFirstOrThrow();
      expect(row.tokenHash).toBe(sha256(token));
      expect(row.tokenHash).not.toContain(token);
      expect(row.usedAt).toBeNull();
      // Short-lived: 30 minutes by default.
      const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(lifetime).toBeGreaterThan(29 * 60_000);
      expect(lifetime).toBeLessThanOrEqual(31 * 60_000);
    });

    it('rejects malformed input', async () => {
      await http().post('/auth/forgot-password').send({}).expect(400);
      await http()
        .post('/auth/forgot-password')
        .send({ email: 'nope' })
        .expect(400);
      await http()
        .post('/auth/forgot-password')
        .send({ email: 'a@example.com', extra: 1 })
        .expect(400);
    });

    it('does not send a second email within the cooldown, then supersedes the old link', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const first = await requestResetToken('real@example.com');

      await http()
        .post('/auth/forgot-password')
        .send({ email: 'real@example.com' })
        .expect(202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ctx.mail.to('real@example.com')).toHaveLength(1);

      // Age the first request past the cooldown; a new request replaces it.
      await ctx.prisma.passwordResetToken.updateMany({
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
      await http()
        .post('/auth/forgot-password')
        .send({ email: 'real@example.com' })
        .expect(202);
      const mails = await waitForMail(ctx.mail, 'real@example.com', 2);
      const second = tokenFrom(mails[1]);

      expect(second).not.toBe(first);
      await http()
        .post('/auth/reset-password')
        .send({ token: first, password: NEW_PASSWORD })
        .expect(400);
      await http()
        .post('/auth/reset-password')
        .send({ token: second, password: NEW_PASSWORD })
        .expect(200);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('sets the new password, revokes all sessions and burns the token', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const laptop = await login(ctx.app, 'real@example.com');
      const phone = await login(ctx.app, 'real@example.com');
      const token = await requestResetToken('real@example.com');

      const res = await http()
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(200);
      expect(res.body).toEqual({ message: expect.any(String) });

      for (const session of [laptop, phone]) {
        await http()
          .get('/auth/me')
          .set(bearer(session.accessToken))
          .expect(401);
        await http()
          .post('/auth/refresh')
          .set(csrfHeaders)
          .set('Cookie', session.cookie)
          .expect(401);
      }
      const row = await ctx.prisma.session.findUniqueOrThrow({
        where: { id: laptop.sessionId },
      });
      expect(row.revokedReason).toBe('PASSWORD_RESET');

      await http()
        .post('/auth/login')
        .send({ email: 'real@example.com', password: TEST_PASSWORD })
        .expect(401);
      await http()
        .post('/auth/login')
        .send({ email: 'real@example.com', password: NEW_PASSWORD })
        .expect(200);

      // Single use.
      await http()
        .post('/auth/reset-password')
        .send({ token, password: 'Another-Passw0rd1' })
        .expect(400);
    });

    it('rejects expired, unknown and malformed tokens', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const expired = await requestResetToken('real@example.com');
      await ctx.prisma.passwordResetToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const attempts = [
        expired,
        'A'.repeat(43),
        'short',
        'has spaces and !!! symbols......',
        '',
      ];
      for (const token of attempts) {
        await http()
          .post('/auth/reset-password')
          .send({ token, password: NEW_PASSWORD })
          .expect(400);
      }
      await http()
        .post('/auth/login')
        .send({ email: 'real@example.com', password: TEST_PASSWORD })
        .expect(200);
    });

    it('keeps the token usable after a weak-password rejection', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const token = await requestResetToken('real@example.com');

      await http()
        .post('/auth/reset-password')
        .send({ token, password: 'weak' })
        .expect(400);
      await http()
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(200);
    });

    it('lets only one of several concurrent submissions succeed', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const token = await requestResetToken('real@example.com');

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          http()
            .post('/auth/reset-password')
            .send({ token, password: NEW_PASSWORD }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    });

    it('does not work for an account disabled after the link was issued', async () => {
      const user = await createUser(ctx.prisma, { email: 'real@example.com' });
      const token = await requestResetToken('real@example.com');
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });

      await http()
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(400);
      const after = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.passwordHash).toBe(user.passwordHash);
    });

    it('verifies the email of an unverified user, who proved ownership of the inbox', async () => {
      const user = await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const token = await requestResetToken('new@example.com');
      await http()
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(200);

      const after = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.emailVerifiedAt).not.toBeNull();
    });

    it('rejects unknown fields', async () => {
      await http()
        .post('/auth/reset-password')
        .send({ token: 'A'.repeat(43), password: NEW_PASSWORD, role: 'ADMIN' })
        .expect(400);
    });
  });

  describe('change-password interaction', () => {
    it('voids outstanding reset links', async () => {
      await createUser(ctx.prisma, { email: 'real@example.com' });
      const token = await requestResetToken('real@example.com');
      const { accessToken } = await login(ctx.app, 'real@example.com');

      await http()
        .patch('/auth/change-password')
        .set(bearer(accessToken))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await http()
        .post('/auth/reset-password')
        .send({ token, password: 'Third-Passw0rd-1' })
        .expect(400);
    });
  });

  describe('email verification', () => {
    it('verifies the address with a single-use emailed token', async () => {
      const user = await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'new@example.com');

      const res = await http()
        .post('/auth/resend-verification')
        .set(bearer(accessToken))
        .expect(202);
      const [mail] = await waitForMail(ctx.mail, 'new@example.com');
      const token = tokenFrom(mail);
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect(mail.text).toContain('/verify-email?token=');

      const row = await ctx.prisma.emailVerificationToken.findFirstOrThrow();
      expect(row.tokenHash).toBe(sha256(token));

      await http().post('/auth/verify-email').send({ token }).expect(200);
      const after = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.emailVerifiedAt).not.toBeNull();

      await http().post('/auth/verify-email').send({ token }).expect(400);
    });

    it('rejects expired, unknown and malformed tokens', async () => {
      await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'new@example.com');
      await http()
        .post('/auth/resend-verification')
        .set(bearer(accessToken))
        .expect(202);
      const [mail] = await waitForMail(ctx.mail, 'new@example.com');
      const token = tokenFrom(mail);
      await ctx.prisma.emailVerificationToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      for (const bad of [token, 'B'.repeat(43), 'x', '']) {
        await http()
          .post('/auth/verify-email')
          .send({ token: bad })
          .expect(400);
      }
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'new@example.com' },
      });
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('requires authentication to resend, and does nothing for verified users', async () => {
      await http().post('/auth/resend-verification').expect(401);

      await createUser(ctx.prisma, { email: 'ok@example.com' });
      const { accessToken } = await login(ctx.app, 'ok@example.com');
      await http()
        .post('/auth/resend-verification')
        .set(bearer(accessToken))
        .expect(202);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ctx.mail.sent).toHaveLength(0);
    });

    it('applies a cooldown to resends and supersedes the previous link', async () => {
      await createUser(ctx.prisma, {
        email: 'new@example.com',
        verified: false,
      });
      const { accessToken } = await login(ctx.app, 'new@example.com');
      const resend = () =>
        http()
          .post('/auth/resend-verification')
          .set(bearer(accessToken))
          .expect(202);

      await resend();
      const [first] = await waitForMail(ctx.mail, 'new@example.com');
      await resend();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ctx.mail.to('new@example.com')).toHaveLength(1);

      await ctx.prisma.emailVerificationToken.updateMany({
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
      await resend();
      const mails = await waitForMail(ctx.mail, 'new@example.com', 2);

      await http()
        .post('/auth/verify-email')
        .send({ token: tokenFrom(first) })
        .expect(400);
      await http()
        .post('/auth/verify-email')
        .send({ token: tokenFrom(mails[1]) })
        .expect(200);
    });
  });
});
