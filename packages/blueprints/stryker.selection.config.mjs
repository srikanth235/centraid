/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.selection.mutation.config.ts", related: false },
  testFiles: ["apps/_shared/selection-engine.test.ts"],
  // The selection bar's rules: which keys a toggle adds or removes, what a
  // shift-range covers, what "select all" means over a filtered set, what
  // survives a refresh (`pruneSelection`), and what a bulk verb is allowed to
  // claim afterwards. A survived mutant here is a member acting on rows they
  // did not select — which is a destructive-action bug, not a UI one.
  mutate: ["apps/_shared/selection-engine.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/selection-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
