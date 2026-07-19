import { jsdomProject } from '@centraid/test-kit/vitest';

export default jsdomProject({
  test: {
    name: '@centraid/web',
    include: ['src/**/*.test.ts'],
  },
});
