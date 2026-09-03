export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.pending-overlay.mutation.config.ts",
    related: false,
  },
  testFiles: [
    "apps/_shared/pending-overlay.test.ts",
    "apps/_shared/pending-overlay-law.test.ts",
    "apps/_shared/pending-overlay-presentation.test.ts",
  ],
  mutate: ["apps/_shared/pending-overlay.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/pending-overlay-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
