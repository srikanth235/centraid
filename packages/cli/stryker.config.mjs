export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/auth.test.ts",
    "src/auth.precedence.test.ts",
    "src/cli.branches.test.ts",
    "src/cli.contract.test.ts",
  ],
  mutate: ["src/auth.ts", "src/cli.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/cli-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
