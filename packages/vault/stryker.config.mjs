export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: ["src/blob/custody-proven.contract.test.ts"],
  // Keep custody as the mutation seed; adding schema drops the up-only vault floor.
  // Build workspace deps before Stryker or unresolved entries report no tests.
  mutate: ["src/blob/custody-proven.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/vault-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
