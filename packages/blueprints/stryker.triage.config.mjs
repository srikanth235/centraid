/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.triage.mutation.config.ts", related: false },
  testFiles: ["apps/_shared/triage-session.test.ts"],
  // The shared triage state machine (#712 D3). Both behaviours that actually
  // bit are arithmetic: a denominator that slides under the member while they
  // answer, and a "skip" that becomes indistinguishable from an answer. Both
  // are exactly what a surviving mutant looks like, and neither is visible in
  // a rendering test.
  mutate: ["apps/_shared/triage-session.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/triage-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
