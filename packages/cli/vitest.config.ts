import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/cli',
    include: ['src/**/*.test.ts'],
  },
});
