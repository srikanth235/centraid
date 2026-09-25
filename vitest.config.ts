import { defineConfig } from "vitest/config";

// #915 Wave 4 merged the twenty tighten-only ledgers into four; the coverage
// floors are `tests/floors.json#coverage`, the same object v8 takes as its
// thresholds map.
import floors from "./tests/floors.json";

// Every workspace that participates in the repo-wide vitest run.
// `vitest.diff-coverage.config.ts` (#576) filters this same list down to the
// packages a diff touches, so the two configs cannot drift into disagreeing
// about what exists.
//
// `desktop/vitest.config.ts` is deliberately NOT here: `cargo xtask gate` runs
// it by name as its `desktop-unit` step (D-1020-F8), and the Electron seat's
// cores carry no floor in `tests/floors.json`.
export const coverageProjects = ["packages/design", "packages/test-kit"];

// What v8 instruments. Shared with the diff-coverage config so a scoped run
// scores the same file set the full run would.
export const coverageInclude = ["packages/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}"];

export const coverageExclude = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.d.ts",
  "**/dist/**",
  "**/index.ts",
];

// Root config: aggregates every package as a Vitest project so `vitest run`
// (and `bun run coverage`) produce ONE v8 coverage report across the
// workspaces — the single coverage tool decision in TESTING.md. Per-package
// runs go through each package's own vitest.config.ts via turbo `test`.
export default defineConfig({
  test: {
    projects: coverageProjects,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: coverageInclude,
      exclude: coverageExclude,
      // Seeded regression floors, a conservative margin below the measured
      // baseline, ratcheted upward as coverage grows. Per-glob keys only gate
      // matching files; everything else is tracked, not gated. Keys are
      // picomatch globs resolved against repo-relative paths.
      thresholds: floors.coverage,
    },
  },
});
