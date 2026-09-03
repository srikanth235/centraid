export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.selection.mutation.config.ts", related: false },
  testFiles: ["apps/_shared/selection-engine.test.ts"],
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
