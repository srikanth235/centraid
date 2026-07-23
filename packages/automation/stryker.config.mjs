/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  // See packages/vault/stryker.config.mjs — vitest plugin dry-run finds 0 tests
  // for this package on ubuntu-latest CI; command runner is the CI-stable path.
  testRunner: 'command',
  commandRunner: {
    command: 'npx vitest run --config vitest.mutation.config.ts --reporter=dot',
  },
  mutate: ['src/fire/scheduler-ledger.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/automation-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 120_000,
  concurrency: 1,
  ignoreStatic: true,
  disableTypeChecks: true,
};
