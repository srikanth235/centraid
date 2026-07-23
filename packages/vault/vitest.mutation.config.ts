import { defineConfig } from 'vitest/config';

/**
 * Standalone Stryker test root for vault custody (contract + properties).
 * Requires workspace packages built (`@centraid/blob-format` dist) on CI.
 */
export default defineConfig({
  test: {
    name: '@centraid/vault-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/blob/custody-proven.contract.test.ts', 'src/blob/custody-properties.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
