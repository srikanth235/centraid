import { defineConfig } from 'vitest/config';

/**
 * Standalone Stryker test root for vault custody.
 * Contract suite only — properties are matrix-gated separately and are too
 * slow under command-runner (full suite per mutant).
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
