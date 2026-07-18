import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'nightly-scale',
    include: ['tests/scale/**/*.scale.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
