import { defineProject } from 'vitest/config';

// Project config for @centraid/ui-core. Coverage + the unified run live in the
// root vitest.config.ts; see TESTING.md. Pure TS units — node environment,
// no DOM.
export default defineProject({
  test: {
    name: '@centraid/ui-core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
