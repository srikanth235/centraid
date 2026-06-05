import { defineProject } from 'vitest/config';

// Project config for @centraid/desktop. Coverage + the unified run live in the root
// vitest.config.ts; see TESTING.md for the strategy. Default pool is 'forks'
// (real child processes) so node:sqlite and the worker-thread handler-runner
// behave as they did under node:test.
export default defineProject({
  test: {
    name: '@centraid/desktop',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
