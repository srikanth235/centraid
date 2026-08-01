import path from "node:path";

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
  plugins: [
    {
      name: "blueprint-component-kit",
      enforce: "pre",
      resolveId(source, importer) {
        if ((source !== "./kit.ts" && source !== "../kit.ts") || !importer)
          return null;
        const appsRoot = path.join(import.meta.dirname, "apps");
        // The kit is the design package's kit layer (#672); apps still import
        // it by the app-relative path the app-engine serves it at.
        return importer.startsWith(`${appsRoot}${path.sep}`)
          ? path.join(import.meta.dirname, "..", "design", "kit", "kit.ts")
          : null;
      },
    },
  ],
  test: {
    name: "@centraid/blueprints",
    include: ["src/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
