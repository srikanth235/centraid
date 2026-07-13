import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@centraid/web',
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
