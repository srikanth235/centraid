import { nodeProject } from './src/vitest.js';

export default nodeProject({
  test: {
    name: '@centraid/test-kit',
    include: ['src/**/*.test.ts'],
  },
});
