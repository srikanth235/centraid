/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  testFiles: ['src/cbsf-properties.test.ts', 'src/cbsf.test.ts'],
  mutate: ['src/index.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/blob-format-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
