import { fileURLToPath } from "node:url";

import { nodeProject } from "@centraid/test-kit/vitest";

// Project config for @centraid/blueprints. Coverage + the unified run live in the root.
//
// The app-boot harness (src/app-boot-harness.ts) serves each `*.module.css` as
// the SAME class-map-exporting JS the gateway does, written to a sibling
// `*.module.css.js` file with the imports rewritten to match — see the note
// there. That `.js` extension is deliberately what keeps Vite/Vitest's own
// CSS-modules transform from hijacking the `.module.css` import and handing the
// app a bogus class map; do not "simplify" it back to a plain `.module.css`.
export default nodeProject({
  resolve: {
    // The apps import the design package's element layer by its real subpath.
    // Aliased to SOURCE here for the same reason the shells do it: a suite must
    // read the package's current tree, never a stale `dist`.
    alias: [
      {
        find: /^@centraid\/design\/elements$/u,
        replacement: fileURLToPath(
          new URL("../design/src/elements/index.ts", import.meta.url)
        ),
      },
      {
        find: /^@centraid\/design$/u,
        replacement: fileURLToPath(
          new URL("../design/src/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    name: "@centraid/blueprints",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      // Source-level suites over the hand-authored connector/enricher
      // handlers published in automations/ (#781).
      "automations/**/*.test.ts",
    ],
  },
});
