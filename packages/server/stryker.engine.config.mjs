/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.engine.mutation.config.ts", related: false },
  testFiles: ["src/engine/pricing/cost-properties.test.ts"],
  mutate: ["src/engine/pricing/cost.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/app-engine-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
