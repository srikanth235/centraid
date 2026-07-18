import { defineProject } from 'vitest/config';

// Project config for @centraid/blueprints. Coverage + the unified run live in the root
// vitest.config.ts; see TESTING.md for the strategy. Default pool is 'forks'
// (real child processes) so node:sqlite and the worker-thread handler-runner
// behave as they did under node:test.
//
// The app-boot harness (src/app-boot-harness.ts) serves each `*.module.css` as
// the SAME class-map-exporting JS the gateway does, written to a sibling
// `*.module.css.js` file with the imports rewritten to match — see the note
// there. That `.js` extension is deliberately what keeps Vite/Vitest's own
// CSS-modules transform from hijacking the `.module.css` import and handing the
// app a bogus class map; do not "simplify" it back to a plain `.module.css`.
export default defineProject({
  test: {
    name: '@centraid/blueprints',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
