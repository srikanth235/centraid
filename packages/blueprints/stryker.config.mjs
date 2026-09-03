export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/app-meta.test.ts",
    "src/app-meta-properties.test.ts",
    "src/app-rewrites.test.ts",
  ],
  mutate: ["src/app-meta.ts", "src/app-rewrites.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/blueprints-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
