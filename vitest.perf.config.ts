import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'nightly-perf',
    include: ['tests/perf/**/*.perf.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
