/** Package-local Stryker options (types from root @stryker-mutator/core). */
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
  // Token precedence + argv parsing / exit-code / output contract. Both files
  // are pure decision logic over injected inputs (`opts.env`, `argv`, a
  // stubbed `fetch`) — `client.ts` is deliberately excluded because its tests
  // stand up a real HTTP server, which is I/O, not a defended pure law.
  mutate: ["src/auth.ts", "src/cli.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "../../artifacts/mutation/cli-report.json" },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
