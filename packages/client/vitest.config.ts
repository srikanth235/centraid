import { fileURLToPath } from 'node:url';
import { jsdomProject } from '@centraid/test-kit/vitest';

export default jsdomProject({
  resolve: {
    alias: {
      '@centraid/design-tokens': fileURLToPath(
        new URL('../design-tokens/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@centraid/client',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
