import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/oauth-worker',
    include: ['src/**/*.test.ts'],
  },
});
