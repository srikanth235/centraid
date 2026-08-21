/** Mutation scope for deterministic ML math; model execution stays in the weekly live lane. */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: ["src/tokenizer.test.ts", "src/ctc.test.ts", "src/nms.test.ts"],
  mutate: ["src/tokenizer.ts", "src/ctc.ts", "src/nms.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/model-runtime-report.json",
  },
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
