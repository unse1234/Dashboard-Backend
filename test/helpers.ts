import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Role } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

export const ORIGIN = 'http://localhost:3000';
export const TEST_PASSWORD = 'Str0ng-Passw0rd!';

/** Headers a browser on the allowed dashboard origin would send to cookie endpoints. */
export const csrfHeaders = { Origin: ORIGIN, 'X-CSRF-Protection': '1' };

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  close: () => Promise<void>;
}

export async function createTestApp(
  customize?: (builder: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<TestContext> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  customize?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    close: () => app.close(),
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Session", "PasswordResetToken", "EmailVerificationToken", "User" CASCADE',
  );
}

let cachedHash: Promise<string> | undefined;
// Hashing is deliberately slow; share one hash across fixtures.
const testPasswordHash = () =>
  (cachedHash ??= argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }));

export interface UserOptions {
  email?: string;
  name?: string;
  role?: Role;
  verified?: boolean;
  active?: boolean;
  /** Pass null to model an invited user who has not set a password yet. */
  password?: string | null;
}

export async function createUser(
  prisma: PrismaService,
  options: UserOptions = {},
) {
  const password =
    options.password === undefined ? TEST_PASSWORD : options.password;
  return prisma.user.create({
    data: {
      email: options.email ?? 'staff@example.com',
      name: options.name ?? 'Test User',
      role: options.role ?? 'STAFF',
      isActive: options.active ?? true,
      emailVerifiedAt: options.verified === false ? null : new Date(),
      passwordHash:
        password === null
          ? null
          : password === TEST_PASSWORD
            ? await testPasswordHash()
            : await argon2.hash(password, { type: argon2.argon2id }),
    },
  });
}

export interface LoginSession {
  accessToken: string;
  /** Full "refresh_token=..." pair, ready for a Cookie header. */
  cookie: string;
  sessionId: string;
}

export async function login(
  app: NestExpressApplication,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<LoginSession> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  const body = response.body as { accessToken: string };
  const cookie = refreshCookie(response);
  if (!cookie) throw new Error('login did not set a refresh cookie');
  return {
    accessToken: body.accessToken,
    cookie,
    sessionId: cookie.split('=')[1].split('.')[0],
  };
}

/** Extracts the "refresh_token=<value>" pair from a response's Set-Cookie headers. */
export function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'] as
    string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const raw = cookies.find((c) => c.startsWith('refresh_token='));
  return raw?.split(';')[0];
}

/** True when the response instructs the browser to delete the refresh cookie. */
export function clearsRefreshCookie(response: request.Response): boolean {
  const header = response.headers['set-cookie'] as
    string[] | string | undefined;
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  return cookies.some(
    (c) =>
      c.startsWith('refresh_token=;') && /expires=Thu, 01 Jan 1970/i.test(c),
  );
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
