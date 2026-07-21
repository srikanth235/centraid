import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/mobile',
    include: ['src/**/*.test.ts'],
  },
});
