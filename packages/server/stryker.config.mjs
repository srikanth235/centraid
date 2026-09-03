export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/cli/allowed-hosts.test.ts",
    "src/cli/allowed-hosts-properties.test.ts",
  ],
  mutate: ["src/cli/allowed-hosts.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/gateway-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
