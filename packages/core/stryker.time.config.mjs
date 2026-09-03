export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.time.mutation.config.ts", related: false },
  testFiles: [
    "src/time/recurrence.test.ts",
    "src/time/rrule-support.test.ts",
    "src/time/recurrence-properties.test.ts",
    "src/time/recurrence-lifecycle-properties.test.ts",
    "src/time/timezone-properties.test.ts",
  ],
  mutate: [
    "src/time/recurrence.ts",
    "src/time/rrule-support.ts",
    "src/time/recurrence-collapse.ts",
    "src/time/recurrence-summary.ts",
    "src/time/timezone.ts",
  ],
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
