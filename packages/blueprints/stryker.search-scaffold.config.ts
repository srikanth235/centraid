/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.search-scaffold.mutation.config.ts",
    related: false,
  },
  testFiles: ["apps/_shared/search-scaffold.test.ts"],
  // The pure half of the search scaffold (#712 S1): grouping caps, the status
  // every app's search surface derives, and per-scope REACH. The reach rules
  // are the ones worth mutating — an audience that could not be reached must
  // never be reported as an audience with no matches, and that difference is
  // one boolean wide.
  //
  // Deliberately OUT: `SearchScaffold.tsx`. It is the component, and its suite
  // (`SearchScaffold.test.tsx`) renders under jsdom — which Stryker's vitest
  // runner cannot see at all (a jsdom project dry-runs as "No tests were
  // executed"), so including it would measure the component against nothing.
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
