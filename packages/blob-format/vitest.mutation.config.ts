import { defineConfig } from 'vitest/config';

/** Standalone Stryker test root for blob-format (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: '@centraid/blob-format-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/cbsf-properties.test.ts', 'src/cbsf.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
