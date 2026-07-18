import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/automation. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: '@centraid/automation',
    include: ['src/**/*.test.ts'],
  },
});
