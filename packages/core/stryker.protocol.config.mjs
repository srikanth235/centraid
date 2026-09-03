export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.protocol.mutation.config.ts", related: false },
  testFiles: [
    "src/protocol/handshake-properties.test.ts",
    "src/protocol/handshake.test.ts",
  ],
  mutate: ["src/protocol/handshake.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/protocol-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
