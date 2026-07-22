import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/protocol',
    include: ['src/**/*.test.ts'],
  },
});
