import { defineProject } from 'vitest/config';

// Project config for @centraid/tunnel. Coverage + the unified run live in the
// root vitest.config.ts; see TESTING.md. The integration tests bind real iroh
// endpoints on loopback with relays disabled, so they run offline; forks pool
// keeps the NAPI binding's tokio runtime isolated per test process.
export default defineProject({
  test: {
    name: '@centraid/tunnel',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
