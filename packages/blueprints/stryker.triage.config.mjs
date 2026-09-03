export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.triage.mutation.config.ts", related: false },
  testFiles: ["apps/_shared/triage-session.test.ts"],
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
