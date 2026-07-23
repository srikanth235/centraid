import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { inlineBlueprintAliases } from '../../packages/client/src/react/blueprints/inline-vite-aliases.ts';

// Builds the React coexistence island (issue #325, Phase 0) into the same
// dist/renderer directory the vanilla tsc output lands in, as a single ES
// module — `react-boot.js` — that the renderer loads via
// <script type="module">. Production build only (no dev server), so React is
// bundled statically and the strict `script-src 'self'` CSP in index.html
// holds. `emptyOutDir: false` because the vanilla `build:ts` / `build:assets`
// steps also write into dist/renderer and must not be wiped.
const fromHere = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The desktop shell document loads over file://, so every emitted asset URL
  // must be relative. The default base '/' made the replica's sqlite worker
  // resolve to file:///assets/… — a path that exists nowhere — so the worker
  // request was canceled and the offline replica never started.
  base: './',
  // Bundle @centraid/design-tokens from its TS source, not its built dist: it
  // emits CommonJS (it's also consumed by the Electron preload), and Rollup
  // can't statically read named exports from a CJS file reached through a
  // workspace symlink. Pulling source also frees the island build from
  // depending on the package being built first. (The former desktop-ui/ui-core
  // packages now live locally under src/renderer/react/ui — no alias needed.)
  resolve: {
    // Array form so the inline-app `./kit.ts` adapter alias sits alongside
    // the design-tokens source alias (issue #505).
    alias: [
      ...inlineBlueprintAliases(),
      {
        find: '@centraid/design-tokens',
        replacement: fromHere('../../packages/design-tokens/src/index.ts'),
      },
    ],
  },
  css: {
    // CSS Modules for co-located `*.module.css` (issue #325, Phase 4 — CSS
    // refactor away from the monolithic global `styles.css`). Component-private
    // classes live next to their component and are scoped here; `styles.foo`
    // in the .tsx resolves to a build-time hash. `localsConvention:
    // 'camelCaseOnly'` lets us author `.stageBg`/`styles.stageBg` cleanly, and
    // the readable `[name]__[local]__[hash]` scope keeps devtools legible
    // (`OnboardingScreen.module__cta__a1b2c`) — a maintainability win over the
    // old opaque global `cd-*` soup. Vitest returns identity keys (its `css` is
    // off) so class-based render tests are unaffected.
    modules: {
      localsConvention: 'camelCaseOnly',
      generateScopedName: '[name]__[local]__[hash:base64:5]',
    },
  },
  build: {
    emptyOutDir: false,
    outDir: 'dist/renderer',
    rollupOptions: {
      input: fromHere('../../packages/client/src/react/boot.tsx'),
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
