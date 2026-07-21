import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/app-engine. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: '@centraid/app-engine',
    include: ['src/**/*.test.ts'],
  },
});
