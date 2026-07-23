import { defineConfig } from 'vitest/config';

/** Unit tests for pure test-report / mutation helpers (not part of package projects). */
export default defineConfig({
  test: {
    name: 'test-report-scripts',
    include: ['scripts/test-report/**/*.test.mjs', 'scripts/mutation/**/*.test.mjs'],
    environment: 'node',
    pool: 'forks',
  },
});
