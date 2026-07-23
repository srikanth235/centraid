/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'packages/automation/vitest.config.ts',
  },
  mutate: [
    'packages/automation/src/**/*.ts',
    '!packages/automation/src/**/*.test.ts',
    '!packages/automation/src/**/*.d.ts',
  ],
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: 'artifacts/mutation/automation-report.json',
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: 'packages/automation/src/**/*.{ts,tsx,js,jsx,html,vue}',
};
