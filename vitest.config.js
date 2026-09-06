import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads .env.test (test DB URL, quiet poller) before any suite runs.
    setupFiles: ['./test/setup.js'],
    // DB-backed suites (auth, follows) truncate shared tables in beforeEach —
    // run files serially so they don't race each other on the one test DB.
    fileParallelism: false,
  },
});
