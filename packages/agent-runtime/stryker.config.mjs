/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: 'npm',
  inPlace: true,
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  testFiles: ['src/low-priority.test.ts', 'src/low-priority-properties.test.ts'],
  // Pure OS priority wrapper — not the full agent-runtime surface.
  mutate: ['src/low-priority.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '../../artifacts/mutation/agent-runtime-report.json' },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
