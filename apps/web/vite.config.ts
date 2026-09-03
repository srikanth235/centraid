import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

import { FONT_FILES, toFontFaceCss } from "@centraid/design/font-faces";
import { fontFilePath } from "@centraid/design/fonts";

const fromHere = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

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

const FONT_BASE = "/fonts";

function centraidFonts(): Plugin {
  const byPath = new Map(
    FONT_FILES.map((file) => [`${FONT_BASE}/${file.fileName}`, file])
  );
  return {
    name: "centraid-fonts",
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
          fileName: `fonts/${file.fileName}`,
          source: readFileSync(fontFilePath(file)),
        });
      }
    },
  };
}

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
    __CENTRAID_FONT_FACE_CSS__: JSON.stringify(toFontFaceCss(FONT_BASE)),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
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
