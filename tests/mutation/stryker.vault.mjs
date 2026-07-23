/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'packages/vault/vitest.config.ts',
  },
  mutate: [
    'packages/vault/src/**/*.ts',
    '!packages/vault/src/**/*.test.ts',
    '!packages/vault/src/**/*.d.ts',
  ],
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: {
    fileName: 'artifacts/mutation/vault-report.json',
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: 'packages/vault/src/**/*.{ts,tsx,js,jsx,html,vue}',
};
