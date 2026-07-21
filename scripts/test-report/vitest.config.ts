import { defineConfig } from 'vitest/config';

/** Unit tests for pure test-report helpers (not part of package projects). */
export default defineConfig({
  test: {
    name: 'test-report-scripts',
    include: ['scripts/test-report/**/*.test.mjs'],
    environment: 'node',
    pool: 'forks',
  },
});
