export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.untrusted.mutation.config.ts",
    related: false,
  },
  testFiles: ["apps/_shared/untrusted-properties.test.ts"],
  mutate: ["apps/_shared/untrusted.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/untrusted-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
