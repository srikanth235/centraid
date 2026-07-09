import { defineProject } from 'vitest/config';

// Project config for @centraid/desktop. Coverage + the unified run live in the root
// vitest.config.ts; see TESTING.md for the strategy. Default pool is 'forks'
// (real child processes) so node:sqlite and the worker-thread handler-runner
// behave as they did under node:test.
//
// Environment is `jsdom` now that extracted renderer logic (format/cron/diff,
// and future render-data/state) lives in testable modules — it gives those
// units the DOM globals they may reach for, while node builtins (fs, sqlite)
// stay available so the main-process logic tests keep working (TESTING.md §2).
export default defineProject({
  // The React island/screens (issue #325) are .tsx; transform them with the
  // automatic JSX runtime so their render tests run in this same project.
  esbuild: { jsx: 'automatic' },
  test: {
    name: '@centraid/desktop',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    // Co-located CSS Modules (issue #325, Phase 4): return the *local* class
    // name from `styles.foo` (→ `'foo'`) instead of Vitest's default hashed
    // `_foo_<hash>`, so render tests keep matching on readable class selectors
    // (`.swatch`, `.cta`) that mirror the module's local names.
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
