import { defineConfig } from 'vitest/config';

/**
 * Standalone Stryker test root for vault custody.
 * Contract suite only: property tests open many SQLite vaults and SIGSEGV under
 * Stryker's threads pool on Linux, dropping the score below the 97 floor.
 * Properties remain matrix-gated for behaviour coverage.
 */
export default defineConfig({
  test: {
    name: '@centraid/vault-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/blob/custody-proven.contract.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
