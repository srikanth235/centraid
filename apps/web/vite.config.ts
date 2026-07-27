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
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Vite 8 moved to rolldown, whose splitting carved the cold shell's
          // critical path from 8 requests (Vite 7) to 15 — same bytes, more
          // round trips. This folds back the small client-owned modules that
          // rolldown split out individually: 15 -> 12 requests, bytes flat.
          //
          // Deliberately NARROW, by explicit module path. Two broader shapes
          // were tried and BOTH ship a blank page (`Cannot read properties of
          // undefined (reading 'onGatewayChanged')`):
          //   - `{ test: /node_modules/ }` (a "vendor" chunk)
          //   - `{ test: /packages\/(client\/src|blob-format\/dist)\// }`
          // Cause: `apps/web/src/web-host.ts` assigns `window.CentraidApi` at
          // module-evaluation time, and hoisting its consumers into one chunk
          // reorders them ahead of that assignment. Grouping cannot express
          // "after web-host"; getting below 12 needs those consumers to stop
          // reading the global at import time, which is a source change.
          //
          // If you widen this regex, re-run apps/web/tests/e2e/perf-waterfall
          // .spec.ts — it asserts the app RENDERS. Request count alone is
          // gameable: the blank-page builds above "improved" to 6 requests.
          groups: [
            {
              name: 'shell-common',
              test: /packages\/(?:client\/src\/(?:video-frame|gateway-auth|gateway-client-core|device-blob-source|gateway-client-devices|replica\/shell-session)|blob-format\/dist\/index)\.(?:ts|js)$/u,
            },
          ],
        },
      },
    },
  },
  plugins: [react()],
});
