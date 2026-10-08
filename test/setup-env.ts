import { config } from 'dotenv';
import { join } from 'node:path';

// Runs in every e2e worker before the app is created. `.env.test` wins over any
// ambient DATABASE_URL so tests can never touch the development database.
config({
  path: join(__dirname, '..', '.env.test'),
  override: true,
  quiet: true,
});

Object.assign(process.env, {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  JWT_ACCESS_SECRET: 'test-only-secret-test-only-secret-test-only-secret',
  MAIL_TRANSPORT: 'console',
  COOKIE_SECURE: 'false',
});

const databaseName = new URL(
  process.env.DATABASE_URL ?? 'postgresql://x/none',
).pathname.slice(1);
if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to run e2e tests: DATABASE_URL points at "${databaseName}", expected a database ending in "_test". Create .env.test first.`,
  );
}
