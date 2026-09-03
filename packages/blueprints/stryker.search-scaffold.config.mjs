export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.search-scaffold.mutation.config.ts",
    related: false,
  },
  testFiles: ["apps/_shared/search-scaffold.test.ts"],
  mutate: ["apps/_shared/search-scaffold.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/search-scaffold-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
