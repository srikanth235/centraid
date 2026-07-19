import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/skills. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: '@centraid/skills',
    include: ['src/**/*.test.ts'],
  },
});
