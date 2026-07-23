import { defineConfig } from 'vitest/config';

/** Standalone Stryker test root for backup (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: '@centraid/backup-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/crypto-properties.test.ts', 'src/wal-address-properties.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
