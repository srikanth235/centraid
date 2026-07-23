import { defineConfig } from 'vitest/config';

// surfaces.test.mjs is node:test (package.json release:surfaces:test); keep it
// out of this vitest include so post-#512 surface matrix does not break the
// #501 release unit lane (sync-versions / restamp).
export default defineConfig({
  test: {
    include: ['scripts/release/**/*.test.mjs'],
    exclude: ['scripts/release/surfaces.test.mjs'],
    environment: 'node',
  },
});
