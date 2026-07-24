/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  testFiles: [
    'src/replica/intent-idempotency-properties.test.ts',
    'src/replica/intents.contract.test.ts',
    'src/replica/payload-hash-identity.test.ts',
    'src/replica/payload-hash-properties.test.ts',
    'src/replica/payload-hash.test.ts',
  ],
  mutate: ['src/replica/intents.ts', 'src/replica/payload-hash.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/client-replica-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
