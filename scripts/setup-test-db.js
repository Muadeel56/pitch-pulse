// Creates the `pitchpulse_test` database (if it doesn't exist yet) and brings
// it up to the latest migration. Idempotent — safe to run before every
// `npm test` (it's wired as the `pretest` script).
//
// Assumes the compose Postgres is up (`docker compose up -d postgres`). The
// CREATE DATABASE step shells into that container; the migrate step runs the
// local Prisma CLI against the test URL from .env.test.
import { execSync } from 'node:child_process';
import { config } from 'dotenv';

config({ path: '.env.test', override: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('setup-test-db: DATABASE_URL missing from .env.test');
  process.exit(1);
}

const dbName = new URL(url).pathname.replace(/^\//, '').split('?')[0];

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

// 1. Ensure the database exists. `createdb` errors if it's already there — that
//    error is expected and ignored; anything else is surfaced.
try {
  sh(
    `docker compose exec -T postgres createdb -U pitchpulse ${dbName}`,
  );
  console.log(`setup-test-db: created database "${dbName}"`);
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (out.includes('already exists')) {
    console.log(`setup-test-db: database "${dbName}" already exists`);
  } else {
    console.error(`setup-test-db: could not create "${dbName}" — is the compose Postgres up?`);
    console.error(out.trim());
    process.exit(1);
  }
}

// 2. Apply migrations against the test database.
try {
  sh('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env } });
  console.log('setup-test-db: migrations applied');
} catch {
  console.error('setup-test-db: prisma migrate deploy failed');
  process.exit(1);
}
