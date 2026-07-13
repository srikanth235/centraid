import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@centraid/design-tokens': fileURLToPath(
        new URL('../design-tokens/src/index.ts', import.meta.url),
      ),
    },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    name: '@centraid/client',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
