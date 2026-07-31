/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/recurrence.test.ts",
    "src/recurrence-properties.test.ts",
    "src/timezone-properties.test.ts",
  ],
  // Pure civil-time arithmetic — no I/O, no host clock, no locale beyond Intl
  // zone data. Both files are fully defended by the laws in
  // `*-properties.test.ts` (round-trips, cadence spacing, COUNT/UNTIL bounds,
  // BYDAY membership, gap/overlap resolution), which is why they qualify as a
  // mutation seed at all: a mutant here changes an answer a law can name.
  mutate: ["src/recurrence.ts", "src/timezone.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/time-engine-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
