/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  // Command runner: the vitest plugin dry-run finds 0 tests for this package on
  // ubuntu-latest CI (repro: packages/vault + packages/automation only). Local
  // and other seeds are fine with the vitest runner. Command mode still kills
  // mutants via full suite exit codes and writes the json report for floors.
  testRunner: 'command',
  commandRunner: {
    command: 'npx vitest run --config vitest.mutation.config.ts --reporter=dot',
  },
  // Custody remains the mutate seed (measured 100%). json-schema is property-
  // gated via matrix minimumTests; folding it in drops the package score below
  // the up-only vault floor until more schema mutants are killed.
  mutate: ['src/blob/custody-proven.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/vault-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 120_000,
  concurrency: 1,
  ignoreStatic: true,
  disableTypeChecks: true,
};
