import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { inlineBlueprintAliases } from '../../packages/client/src/react/blueprints/inline-vite-aliases.ts';

const fromHere = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const appVersion = JSON.parse(readFileSync(fromHere('./package.json'), 'utf8')).version as string;

export default defineConfig({
  resolve: {
    // Array form so the inline-app `./kit.ts` adapter alias sits alongside
    // the package aliases (issue #505).
    alias: [
      ...inlineBlueprintAliases(),
      { find: '@centraid/client', replacement: fromHere('../../packages/client/src') },
      {
        find: '@centraid/design-tokens',
        replacement: fromHere('../../packages/design-tokens/src/index.ts'),
      },
    ],
  },
  define: {
    // Real package version for the web shell (issue #468 K9).
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  plugins: [react()],
});
