/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: ["src/css-properties.test.ts", "src/tile-properties.test.ts"],
  // VALUE LOGIC ONLY. `css.ts` (block assembly + kebab-case mapping + px
  // suffixes), `typography.ts` (`typeShorthand`), and `tile.ts` (hex parse,
  // channel shading with a clamp, alpha composition) are pure functions of
  // the token tables. The tables themselves (palette/radii/density/themes/
  // icons) are declarations, not logic — mutating a hex literal produces a
  // mutant no law can legitimately kill, so they stay out.
  //
  // NOTE: the seeded tests call `toCss()` INSIDE each test. `ignoreStatic`
  // discards mutants only reachable from module-scope evaluation, and the
  // pre-existing `css.test.ts` hoists `const css = toCss()` to module scope —
  // which is why this file measured n/a (zero mutants) before #656 Layer 3.
  mutate: ["src/css.ts", "src/typography.ts", "src/tile.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/design-tokens-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
