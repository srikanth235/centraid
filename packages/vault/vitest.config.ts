import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/vault. Coverage + the unified run live in the root.
export default nodeProject({
  test: {
    name: '@centraid/vault',
    include: ['src/**/*.test.ts'],
  },
});
