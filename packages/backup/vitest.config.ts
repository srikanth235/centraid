import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/backup. Coverage + the unified run live in the
// root vitest.config.ts; see TESTING.md.
export default nodeProject({
  test: {
    name: '@centraid/backup',
    include: ['src/**/*.test.ts'],
  },
});
