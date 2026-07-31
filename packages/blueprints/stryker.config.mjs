/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/scaffold-files.test.ts",
    "src/scaffold-files-properties.test.ts",
    "src/app-rewrites.test.ts",
  ],
  // The filesystem-free file-map builders (issue #141) plus the rename
  // rewriters they call. `scaffold-files.ts` is pure in/out — id validation,
  // HTML escaping, manifest assembly, changed-file selection — and
  // `app-rewrites.ts` is the same string layer plus four thin readFile /
  // writeFile wrappers whose only behaviour is "missing → no-op, changed →
  // write", pinned by temp-dir tests.
  //
  // Deliberately OUT: `scaffold.ts` / `clone.ts` / `index.ts` (directory
  // walks, remote template fetch) and `scaffold-defaults.ts` (long CSS/JS
  // template literals — string mutants there have no law to kill them).
  mutate: ["src/scaffold-files.ts", "src/app-rewrites.ts"],
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
