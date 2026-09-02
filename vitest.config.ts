import { defineConfig } from "vitest/config";

import { mobileVitestProjects } from "./apps/mobile/vitest.projects";
// #915 Wave 4 merged the twenty tighten-only ledgers into four; the coverage
// floors are `tests/floors.json#coverage`, the same object v8 takes as its
// thresholds map.
import floors from "./tests/floors.json";

// Every package that participates in the repo-wide vitest run. `vitest.diff-
// coverage.config.ts` (#576) filters this same list down to the packages a diff
// touches, so the two configs cannot drift into disagreeing about what exists.
export const coverageProjects = [
  "vitest.quality.config.ts",
  "packages/core",
  "packages/server",
  "packages/backup",
  "packages/blueprints",
  "packages/client",
  "packages/design",
  "packages/cli",
  "packages/tunnel",
  "packages/test-kit",
  "packages/vault",
  "apps/desktop",
  "apps/extension",
  ...mobileVitestProjects,
  "apps/oauth-worker",
  "apps/web",
  "packages/model-runtime",
];

// What v8 instruments. Shared with the diff-coverage config so a scoped run
// scores the same file set the full run would.
export const coverageInclude = [
  "packages/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "apps/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  // The bundled apps are production code co-located outside
  // packages/blueprints/src (issue #630 Wave 0). The browser substrate they
  // render on needs no row of its own since #799 folded it into
  // packages/design/src/elements, which the conventional pattern above covers.
  "packages/blueprints/apps/**/*.{ts,tsx}",
  // The hand-authored source of the published recognition automations. It
  // lives outside packages/model-runtime/src because it is bundled per handler
  // rather than compiled with the package (issue #781). Only `.js` is
  // instrumented: the tree's `.ts` files are its suites and their harness.
  "packages/model-runtime/automation-handlers/**/*.js",
  // The hand-authored connector/enricher handlers published under
  // packages/blueprints/automations (#781). Only the `handler.js` files are
  // product runtime; app.json/automation.json are manifests and the tree's
  // `.ts` files are its suites and their harness. The six GENERATED
  // recognition bundles are excluded below — their source is instrumented
  // and floored under packages/model-runtime/automation-handlers, and
  // bundle-drift.test.ts proves the published copies are the same program,
  // so instrumenting the minified copy would double-count it.
  "packages/blueprints/automations/**/handler.js",
  // The PWA service worker is load-bearing production offline/caching code that
  // lives outside src/ only because it must be served from the PWA root. Named
  // file, not `apps/*/public/**` — the rest of public/ is static assets (issue
  // #656 Layer 1F).
  "apps/web/public/sw.js",
];

export const coverageExclude = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.d.ts",
  "**/dist/**",
  "**/index.ts",
  // Test-only harnesses (issue #545 B12) — not product surface.
  "packages/backup/src/testing/**",
  // wasm-bindgen glue for the web iroh transport — generated, not hand-owned.
  "apps/web/src/generated/**",
  // In-tree ACP fake harness used by agent-runtime tests, not product code.
  "packages/server/src/acp/backends/acp/fake-acp-harness.mjs",
  // Generated recognition bundles: source-floored upstream (see the
  // packages/blueprints/automations include note above). The id list matches
  // packages/model-runtime/build-automation-handlers.ts.
  "packages/blueprints/automations/{embed-image,embed-text,faces,photo-ocr,place-names,transcript}/**",
];

// Root config: aggregates every package as a Vitest project so `vitest run`
// (and `bun run coverage`) produce ONE v8 coverage report across the whole
// repo — the single coverage tool decision in TESTING.md. Per-package runs go
// through each package's own vitest.config.ts via turbo `test`.
export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: coverageInclude,
      exclude: coverageExclude,
      // Engine packages are where the meaningful coverage lives (TESTING.md).
      // These are the *seeded* regression floors — set a conservative margin
      // below the measured baseline so they catch backsliding without flaking,
      // then ratchet upward as coverage grows. Whole *screen* surfaces —
      // desktop renderer, and mobile's screens — stay ungated: their
      // meaningful coverage is logic-units + e2e journeys, not a line
      // percentage. That is a claim about screens, not about the app: since
      // #839 `apps/mobile` carries floors over its extracted pure logic
      // (`src/lib/**` and the `*-model.ts` view models, which is where the
      // `src/kit/components/{bars,doc-table}-model.ts` pair is gated too),
      // exactly the surface those journeys cannot falsify cheaply. Per-glob keys only
      // gate matching files; everything else is tracked, not gated. Keys are
      // picomatch globs resolved against repo-relative paths, and each key
      // gets its own coverage map, so two keys may overlap on a file.
      thresholds: floors.coverage,
    },
  },
});
