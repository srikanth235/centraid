import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@centraid/mobile',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
