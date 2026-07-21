import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: 'blob-format',
    include: ['src/**/*.test.ts'],
  },
});
