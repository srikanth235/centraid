import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@centraid/extension',
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
