import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

import { FONT_FILES, toFontFaceCss } from "@centraid/design/font-faces";
import { fontFilePath } from "@centraid/design/fonts";

const fromHere = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

// Exact `.tsx` descriptors: the package `./apps/*` map is `*.ts`, and the
// client tsconfig stub has no runtime default. A miss loads `undefined` and
// the inline host dies on `descriptor.queries`.
const INLINE_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
] as const;

const blueprintInlineAliases = INLINE_APPS.map((app) => ({
  find: new RegExp(
    `^@centraid\\/blueprints\\/apps\\/${app}\\/app-inline$`,
    "u"
  ),
  replacement: fromHere(`../../packages/blueprints/apps/${app}/app-inline.tsx`),
}));

const appVersion = JSON.parse(readFileSync(fromHere("./package.json"), "utf8"))
  .version as string;

/** Absolute, never relative (#707): the PWA is one document at every route, so
 * a relative `fonts/…` resolves against the deep link and 404s. */
const FONT_BASE = "/fonts";

/** Vendored `.woff2` faces from this app's OWN origin, so `FONT_FILES` alone
 * decides what ships. A CDN is not an option: the shell paints offline under a
 * strict CSP, and a cross-origin font hands a third party every reader's IP. */
function centraidFonts(): Plugin {
  const byPath = new Map(
    FONT_FILES.map((file) => [`${FONT_BASE}/${file.fileName}`, file])
  );
  return {
    name: "centraid-fonts",
    // `vite dev` has no dist; serve the same URLs from the package.
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
          // CSS and `_headers` long-caches `/fonts/*`.
          fileName: `fonts/${file.fileName}`,
          source: readFileSync(fontFilePath(file)),
        });
      }
    },
  };
}

/**
 * ONE ~2 MB Iroh WASM on the wire (#883 C5). The ESM bindings' `__wbg_init`
 * default emits a second hashed copy beside the one `build-iroh-worker.mjs`
 * publishes for the CLASSIC service worker; the worker's cannot go
 * (`importScripts` needs an unhashed path nameable before the build), so
 * rewrite the bindings' default to it. `?v=` busts a year-immutable copy.
 *
 * Throws rather than no-opping: a wasm-bindgen upgrade that changes the
 * expression would otherwise quietly restore the duplicate.
 */
const IROH_WASM_BINDINGS = "src/generated/centraid_web_iroh.js";
const IROH_WASM_DEFAULT_URL =
  /new URL\("centraid_web_iroh_bg\.wasm", import\.meta\.url\)/u;

function irohWasmSingleCopy(): Plugin {
  const version = (() => {
    const source = readFileSync(fromHere("./src/sw-version.ts"), "utf8");
    const match =
      /SERVICE_WORKER_VERSION\s*=\s*['"](?<version>[^'"]+)['"]/u.exec(source);
    if (!match?.groups?.version)
      throw new Error(
        "centraid-iroh-wasm-single-copy: could not read SERVICE_WORKER_VERSION from src/sw-version.ts"
      );
    return match.groups.version;
  })();
  return {
    name: "centraid-iroh-wasm-single-copy",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith(IROH_WASM_BINDINGS)) return null;
      if (!IROH_WASM_DEFAULT_URL.test(code))
        throw new Error(
          `centraid-iroh-wasm-single-copy: ${IROH_WASM_BINDINGS} no longer contains the wasm-bindgen default URL expression — re-derive the rewrite after the binding upgrade`
        );
      return {
        code: code.replace(
          IROH_WASM_DEFAULT_URL,
          JSON.stringify(`/centraid-worker-iroh.wasm?v=${version}`)
        ),
        map: null,
      };
    },
  };
}

export default defineConfig({
  resolve: {
    // Anchor every pattern: `@centraid/design` must not eat its subpaths.
    alias: [
      {
        find: /^@centraid\/blueprints\/apps\/_shared\/format-kit$/u,
        replacement: fromHere(
          "../../packages/blueprints/apps/_shared/format-kit.ts"
        ),
      },
      ...blueprintInlineAliases,
      {
        find: "@centraid/client",
        replacement: fromHere("../../packages/client/src"),
      },
      {
        // Never folded into the barrel: the design root is reachable from
        // Expo and stays DOM-free.
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
    // cannot import it; `define` carries its string OUTPUT instead (#707).
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
          //
          // Two module-scope `CentraidApi` readers keep evaluation order
          // load-bearing: `packages/client/src/gateway-client-editing.ts`
          // (unguarded — it THROWS if it evaluates first) and
          // `react/shell/routes/useAppScopes.ts` (optional-chained, so it
          // silently drops its subscription).
          //
          // Deleting this block was built and weighed (#883 C5): more files,
          // more bytes. Route-level `React.lazy` needs both readers fixed AND
          // a build that beats those numbers.
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
  plugins: [react(), centraidFonts(), irohWasmSingleCopy()],
});
