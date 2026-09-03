export default {
  packageManager: "npm",
  inPlace: true,
  testRunner: "vitest",
  vitest: { configFile: "vitest.acp.mutation.config.ts", related: false },
  testFiles: [
    "src/acp/low-priority.test.ts",
    "src/acp/low-priority-properties.test.ts",
  ],
  mutate: ["src/acp/low-priority.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/agent-runtime-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
