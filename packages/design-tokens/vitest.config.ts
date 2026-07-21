import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: 'design-tokens',
    include: ['src/**/*.test.ts'],
  },
});
