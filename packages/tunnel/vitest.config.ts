import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/tunnel. Coverage + the unified run live in the
// root vitest.config.ts; see TESTING.md. The integration tests bind real iroh
// endpoints on loopback with relays disabled, so they run offline.
export default nodeProject({
  test: {
    name: '@centraid/tunnel',
    include: ['src/**/*.test.ts'],
  },
});
