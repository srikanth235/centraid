import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the React coexistence island (issue #325, Phase 0) into the same
// dist/renderer directory the vanilla tsc output lands in, as a single ES
// module — `react-boot.js` — that the renderer loads via
// <script type="module">. Production build only (no dev server), so React is
// bundled statically and the strict `script-src 'self'` CSP in index.html
// holds. `emptyOutDir: false` because the vanilla `build:ts` / `build:assets`
// steps also write into dist/renderer and must not be wiped.
const fromHere = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Bundle the workspace UI packages from their TS source, not their built
  // dist. design-tokens emits CommonJS (it's also consumed by the Electron
  // preload), and Rollup can't statically read named exports from a CJS file
  // reached through a workspace symlink. Pulling source also frees the island
  // build from depending on the packages being built first.
  resolve: {
    alias: {
      '@centraid/design-tokens': fromHere('../../packages/design-tokens/src/index.ts'),
      '@centraid/desktop-ui': fromHere('../../packages/desktop-ui/src/index.ts'),
      '@centraid/ui-core': fromHere('../../packages/ui-core/src/index.ts'),
    },
  },
  build: {
    emptyOutDir: false,
    outDir: 'dist/renderer',
    rollupOptions: {
      input: fromHere('src/renderer/react/boot.tsx'),
      output: {
        assetFileNames: 'react-[name][extname]',
        chunkFileNames: 'react-[name]-[hash].js',
        entryFileNames: 'react-boot.js',
      },
    },
    sourcemap: true,
  },
  plugins: [react()],
});
