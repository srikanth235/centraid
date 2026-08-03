import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

import {
  FONT_FILES,
  fontFilePath,
  toFontFaceCss,
} from "@centraid/design/fonts";

import { inlineBlueprintAliases } from "../../packages/client/src/react/blueprints/inline-vite-aliases.ts";

const fromHere = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

const appVersion = JSON.parse(readFileSync(fromHere("./package.json"), "utf8"))
  .version as string;

/**
 * Same-origin path the four Binding Layer faces are served from (#707).
 *
 * Absolute, not relative: the PWA is a single document served at every route
 * (`/`, `/apps/…`, `/settings`), and the token <style> is injected once at
 * boot — a relative `fonts/…` would resolve against whatever path the user
 * happened to deep-link into, and 404 on all but the root.
 */
const FONT_BASE = "/fonts";

/**
 * Serve `@centraid/design`'s vendored `.woff2` files from this app's OWN
 * origin, in dev and in the build.
 *
 * The faces are emitted as build assets rather than copied into `public/`:
 * `public/` is a tracked source directory, and 160 KB of binaries that a
 * build step regenerates does not belong in one (the iroh worker gets away
 * with it only because it is gitignored). Emitting keeps the source tree
 * clean and makes the manifest in `FONT_FILES` the single decider of what
 * ships.
 *
 * A CDN is not an option here even though a CDN is the usual answer: the
 * shell installs as a PWA and is expected to paint offline, its app surfaces
 * run behind a strict CSP, and a cross-origin font is a third party learning
 * every reader's IP on first paint.
 */
function centraidFonts(): Plugin {
  const byPath = new Map(
    FONT_FILES.map((file) => [`${FONT_BASE}/${file.fileName}`, file])
  );
  return {
    name: "centraid-fonts",
    // `vite dev` has no dist to read from; answer the same URLs from the
    // package directory so dev and prod resolve identically.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = byPath.get((req.url ?? "").split("?")[0] ?? "");
        if (!file) {
          next();
          return;
        }
        res.setHeader("Content-Type", "font/woff2");
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(fontFilePath(file)));
      });
    },
    generateBundle() {
      for (const file of FONT_FILES) {
        this.emitFile({
          type: "asset",
          // Unhashed and outside `/assets/`: the URL is baked into the token
          // CSS string the preload/boot injects, so it must be predictable,
          // and `_headers` long-caches `/fonts/*` by that same literal path.
          fileName: `fonts/${file.fileName}`,
          source: readFileSync(fontFilePath(file)),
        });
      }
    },
  };
}

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
    // The `@font-face` block, generated in Node at config time and inlined as
    // a string constant. `@centraid/design/fonts` reaches for `node:path`, so
    // it can never be imported by the browser bundle — but its OUTPUT is a
    // plain string, and `define` is the seam that already carries build-time
    // facts into this app (issue #707).
    __CENTRAID_FONT_FACE_CSS__: JSON.stringify(toFontFaceCss(FONT_BASE)),
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
  plugins: [react(), centraidFonts()],
});
