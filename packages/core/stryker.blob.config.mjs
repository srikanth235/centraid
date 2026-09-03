export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.blob.mutation.config.ts", related: false },
  testFiles: ["src/blob/cbsf-properties.test.ts", "src/blob/cbsf.test.ts"],
  mutate: ["src/blob/cbsf.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/blob-format-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
