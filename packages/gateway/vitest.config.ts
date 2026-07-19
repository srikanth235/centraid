import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/gateway. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: '@centraid/gateway',
    include: ['src/**/*.test.ts'],
  },
});
