import { defineProject } from 'vitest/config';

// Project config for @centraid/vault. Coverage + the unified run live in the root
// vitest.config.ts; see TESTING.md for the strategy. Default pool is 'forks'
// (real child processes) so node:sqlite behaves as it does in production.
export default defineProject({
  test: {
    name: '@centraid/vault',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
