import { defineConfig } from 'vitest/config';

/** Standalone Stryker test root for app-engine (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: '@centraid/app-engine-mutation',
    environment: 'node',
    pool: 'forks',
    include: ['src/pricing/cost-properties.test.ts'],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
