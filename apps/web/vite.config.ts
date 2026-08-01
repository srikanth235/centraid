import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { inlineBlueprintAliases } from "../../packages/client/src/react/blueprints/inline-vite-aliases.ts";

const fromHere = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

const appVersion = JSON.parse(readFileSync(fromHere("./package.json"), "utf8"))
  .version as string;

export default defineConfig({
  resolve: {
    // Array form so the inline-app `./kit.ts` adapter alias sits alongside
    // the package aliases (issue #505).
    alias: [
      ...inlineBlueprintAliases(),
      {
        find: "@centraid/client",
        replacement: fromHere("../../packages/client/src"),
      },
      // The kit layer is a directory of served assets; the token layer is a
      // single module. Anchor the root so `@centraid/design/kit/*` subpath
      // imports resolve to files instead of into the token module's path.
      {
        find: "@centraid/design/kit",
        replacement: fromHere("../../packages/design/kit"),
      },
      {
        find: /^@centraid\/design$/u,
        replacement: fromHere("../../packages/design/src/index.ts"),
      },
    ],
  },
  define: {
    // Real package version for the web shell (issue #468 K9).
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
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
          //
          // ROUTE-LEVEL CODE SPLITTING WAS TRIED AND WAIVED (issue #659 C7).
          // Recorded here so nobody repeats the experiment from scratch.
          //
          // Making the shell's 18 non-first-paint routes `React.lazy` MEASURED
          // WORSE on the cold shell, not better:
          //
          //     requests 12 -> 73     transfer 387,990 B -> 857,155 B
          //
          // The routes themselves were NOT the cost — 0 of those 73 requests
          // was a lazy route chunk. The damage was indirect: 18 `import()`
          // boundaries fragmented the EAGER graph into ~70 chunks (40 of them
          // under 3 KB, 60 KB in total), and compressing 70 small files
          // separately costs far more than compressing a few large ones.
          //
          // Four ways out were measured. `codeSplitting.minSize` changed
          // nothing; `minShareCount: 4` made it worse (100 -> 103 chunks);
          // grouping routes + screens gave 21 chunks but a 1.24 MB chunk the
          // eager graph pulls; grouping only the 18 route modules gave 22
          // chunks AND A BLANK APP — the ordering hazard above.
          //
          // PRECONDITION for retrying: `packages/client/src/gateway-client-
          // core.ts` and `packages/client/src/vault-change-feed.ts` each
          // subscribe to `window.CentraidApi` at MODULE-EVALUATION time, and
          // their relative order is itself load-bearing (vault-change-feed's
          // own comment relies on gateway-client-core being imported above it).
          // Splitting is viable only once those subscriptions stop being
          // eval-time side effects — an explicit init the host calls after
          // installing the API, ordered deliberately rather than by import
          // order — and it must then be RE-MEASURED, because nothing here shows
          // splitting wins even with the hazard gone. A blank app is a far
          // worse outcome than an unsplit bundle.
          groups: [
            {
              name: "shell-common",
              test: /packages\/(?:client\/src\/(?:video-frame|gateway-auth|gateway-client-core|device-blob-source|gateway-client-devices|replica\/shell-session)|blob-format\/dist\/index)\.(?:ts|js)$/u,
            },
          ],
        },
      },
    },
  },
  plugins: [react()],
});
