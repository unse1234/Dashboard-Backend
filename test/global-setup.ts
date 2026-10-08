import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';
import { join } from 'node:path';

/** Applies all committed migrations to the test database before any suite runs. */
export default function globalSetup(): void {
  const root = join(__dirname, '..');
  config({ path: join(root, '.env.test'), override: true, quiet: true });

  const url = process.env.DATABASE_URL;
  const name = url ? new URL(url).pathname.slice(1) : '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to migrate "${name}": the e2e database name must end in "_test" (see .env.test).`,
    );
  }

  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'prisma', 'build', 'index.js'),
      'migrate',
      'deploy',
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
}
