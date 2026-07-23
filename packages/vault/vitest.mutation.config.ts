import { defineConfig } from 'vitest/config';

/**
 * Standalone Stryker test root (defineConfig, not defineProject).
 * Include the contract suite (fast, original seed) plus properties.
 */
export default defineConfig({
  test: {
    name: '@centraid/vault-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/blob/custody-proven.contract.test.ts', 'src/blob/custody-properties.test.ts'],
    // SQLite bootstrap under Stryker instrumentation is slower on CI hosts.
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
