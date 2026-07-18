import { nodeProject } from '@centraid/test-kit/vitest';

// Project config for @centraid/blueprints. Coverage + the unified run live in the root.
//
// The app-boot harness (src/app-boot-harness.ts) serves each `*.module.css` as
// the SAME class-map-exporting JS the gateway does, written to a sibling
// `*.module.css.js` file with the imports rewritten to match — see the note
// there. That `.js` extension is deliberately what keeps Vite/Vitest's own
// CSS-modules transform from hijacking the `.module.css` import and handing the
// app a bogus class map; do not "simplify" it back to a plain `.module.css`.
export default nodeProject({
  test: {
    name: '@centraid/blueprints',
    include: ['src/**/*.test.ts'],
  },
});
