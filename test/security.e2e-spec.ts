import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import {
  createTestApp,
  createUser,
  ORIGIN,
  resetDatabase,
  TEST_PASSWORD,
  type TestContext,
} from './helpers';

describe('HTTP security (e2e)', () => {
  describe('headers and CORS', () => {
    let ctx: TestContext;
    const http = () => request(ctx.app.getHttpServer());

    beforeAll(async () => {
      ctx = await createTestApp();
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('keeps the starter endpoint public and sets security headers', async () => {
      const res = await http().get('/').expect(200);
      expect(res.text).toBe('Hello World!');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('allows credentialed CORS only for configured origins', async () => {
      const allowed = await http()
        .options('/auth/refresh')
        .set({
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-csrf-protection,content-type',
        })
        .expect(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect(allowed.headers['access-control-allow-headers']).toMatch(
        /x-csrf-protection/i,
      );

      const denied = await http().options('/auth/refresh').set({
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      expect(
        denied.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    });

    it('does not echo CORS headers to a disallowed origin on normal requests', async () => {
      const res = await http()
        .post('/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'a@example.com', password: 'x' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('returns JSON errors that do not leak internals', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email: 1 })
        .expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(Array),
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /stack|prisma|node_modules/i,
      );
    });
  });

  describe('rate limiting', () => {
    let ctx: TestContext;
    const http = () => request(ctx.app.getHttpServer());

    beforeAll(async () => {
      ctx = await createTestApp();
      // Env is validated when AppModule is first imported (limiting is off for the
      // suite), so switch it on for this app through the live config instead.
      ctx.app.get(ConfigService).set('RATE_LIMIT_ENABLED', true);
      await resetDatabase(ctx.prisma);
      await createUser(ctx.prisma, { email: 'victim@example.com' });
      await createUser(ctx.prisma, { email: 'other@example.com' });
    });
    afterAll(async () => {
      await resetDatabase(ctx.prisma);
      await ctx.close();
    });

    it('throttles repeated login attempts per account and does not affect other accounts', async () => {
      const attempt = (email: string, password: string) =>
        http().post('/auth/login').send({ email, password });

      for (let i = 0; i < 5; i++) {
        await attempt('victim@example.com', 'Wrong-Passw0rd!!').expect(401);
      }
      const blocked = await attempt('victim@example.com', TEST_PASSWORD).expect(
        429,
      );
      expect(blocked.headers['retry-after']).toBeDefined();

      // Same address, different account: separate budget.
      await attempt('other@example.com', TEST_PASSWORD).expect(200);
    });

    it('keeps blocking the throttled account regardless of email casing', async () => {
      await http()
        .post('/auth/login')
        .send({ email: ' VICTIM@example.com ', password: TEST_PASSWORD })
        .expect(429);
    });
  });
});
