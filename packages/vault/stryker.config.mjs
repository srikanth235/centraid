/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  testFiles: ['src/blob/custody-proven.contract.test.ts', 'src/blob/custody-properties.test.ts'],
  // Custody remains the mutate seed (measured 100%). json-schema is property-
  // gated via matrix minimumTests; folding it in drops the package score below
  // the up-only vault floor until more schema mutants are killed.
  // CI must build workspace deps (@centraid/blob-format) before Stryker —
  // unresolved package entries surface as "No tests were executed".
  mutate: ['src/blob/custody-proven.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/vault-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
