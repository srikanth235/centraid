import { defineProject } from 'vitest/config';

// Project config for @centraid/backup. Coverage + the unified run live in the
// root vitest.config.ts; see TESTING.md. Tests use real temp dirs (fs.mkdtemp)
// and real in-process node:http fakes — no fs or network mocks — so a longer
// default timeout covers the engine/remote-provider suites without flaking.
export default defineProject({
  test: {
    name: '@centraid/backup',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
