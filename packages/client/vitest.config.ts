import { fileURLToPath } from 'node:url';
import { jsdomProject } from '@centraid/test-kit/vitest';
import { inlineBlueprintAliases } from './src/react/blueprints/inline-vite-aliases.ts';

export default jsdomProject({
  resolve: {
    // Array form so the inline-app `./kit.ts` adapter alias applies under
    // vitest too (issue #505).
    alias: [
      ...inlineBlueprintAliases(),
      {
        find: '@centraid/design-tokens',
        replacement: fileURLToPath(new URL('../design-tokens/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: '@centraid/client',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
