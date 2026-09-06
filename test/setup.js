// Runs once per test file, before the suite. Loads .env.test so every test
// sees the test database URL and a quiet poller. `override: true` so a stale
// value already in the shell environment can't leak the dev DB into a run.
import { config } from 'dotenv';

config({ path: '.env.test', override: true });
