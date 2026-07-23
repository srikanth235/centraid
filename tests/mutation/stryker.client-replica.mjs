/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'packages/client/vitest.config.ts',
  },
  mutate: [
    'packages/client/src/replica/**/*.ts',
    '!packages/client/src/replica/**/*.test.ts',
    '!packages/client/src/replica/**/*.d.ts',
  ],
  // Restrict test runner to replica suite so Stryker does not pay for the full client project.
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: 'artifacts/mutation/client-replica-report.json',
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: 'packages/client/src/replica/**/*.{ts,tsx,js,jsx,html,vue}',
};
