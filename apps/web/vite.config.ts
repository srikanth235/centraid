import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

import { FONT_FILES, toFontFaceCss } from "@centraid/design/font-faces";
import { fontFilePath } from "@centraid/design/fonts";

const fromHere = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

const appVersion = JSON.parse(readFileSync(fromHere("./package.json"), "utf8"))
  .version as string;

/** Absolute, never relative (#707): the PWA is one document at every route, so
 * a relative `fonts/…` resolves against the deep-linked path and 404s. */
const FONT_BASE = "/fonts";

/** Vendored `.woff2` faces from this app's OWN origin, emitted as build assets
 * so `FONT_FILES` alone decides what ships. A CDN is not an option: the shell
 * paints offline under a strict CSP, and a cross-origin font hands a third
 * party every reader's IP. */
function centraidFonts(): Plugin {
  const byPath = new Map(
    FONT_FILES.map((file) => [`${FONT_BASE}/${file.fileName}`, file])
  );
  return {
    name: "centraid-fonts",
    // `vite dev` has no dist: answer the same URLs from the package directory.
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
          // Unhashed and outside `/assets/`: the URL is baked into the injected
          // token CSS, and `_headers` long-caches `/fonts/*` by that path.
          fileName: `fonts/${file.fileName}`,
          source: readFileSync(fontFilePath(file)),
        });
      }
    },
  };
}

export default defineConfig({
  resolve: {
    // Every pattern anchored: `@centraid/design` must not swallow its subpaths.
    alias: [
      {
        find: "@centraid/client",
        replacement: fromHere("../../packages/client/src"),
      },
      {
        // Never folded into the barrel: the design root is reachable from Expo
        // and must stay DOM-free.
        find: /^@centraid\/design\/elements$/u,
        replacement: fromHere("../../packages/design/src/elements/index.ts"),
      },
      {
        find: /^@centraid\/design\/kit\.css$/u,
        replacement: fromHere("../../packages/design/src/elements/kit.css"),
      },
      {
        find: /^@centraid\/design$/u,
        replacement: fromHere("../../packages/design/src/index.ts"),
      },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    // `@centraid/design/fonts` reaches for `node:path`, so the browser bundle
    // can never import it; `define` carries its string OUTPUT instead (#707).
    __CENTRAID_FONT_FACE_CSS__: JSON.stringify(toFontFaceCss(FONT_BASE)),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // NARROW by module path: broader groups ship a BLANK PAGE, because
          // `web-host.ts` assigns `window.CentraidApi` at module-evaluation
          // time and grouping reorders its consumers ahead of it. Widening this
          // regex means re-running `tests/e2e/perf-waterfall.spec.ts`, which
          // asserts the app RENDERS — request count alone is gameable.
          // Route-level `React.lazy` is waived and measured worse (#659):
          // retrying means first ending the eval-time subscriptions in
          // `gateway-client-core.ts` and `vault-change-feed.ts`.
          groups: [
            {
              name: "shell-common",
              test: /packages\/(?:client\/src\/(?:gateway-auth|gateway-client-core|device-blob-source|gateway-client-devices|replica\/shell-session)|blueprints\/apps\/_shared\/video-frame|blob-format\/dist\/index)\.(?:ts|js)$/u,
            },
          ],
        },
      },
    },
  },
  plugins: [react(), centraidFonts()],
});
