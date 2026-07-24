import { defineConfig } from 'vitest/config';

/**
 * Standalone Stryker test root (defineConfig, not defineProject).
 * Scheduler ledger contract + properties live in one file.
 */
export default defineConfig({
  test: {
    name: '@centraid/automation-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/fire/scheduler-ledger.contract.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
