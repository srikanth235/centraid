import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Production island → dist/renderer/`react-boot.js` (static bundle so `script-src 'self'` holds). `emptyOutDir: false`: `build:ts` / `build:assets` also write here.
const fromHere = (p: string): string =>
  fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // file:// shell: default `base: '/'` resolved the replica sqlite worker to `file:///assets/…` and it never started.
  base: "./",
  // Source @centraid/design, not dist: dist is CJS (preload) and Rollup cannot read named exports through a workspace symlink.
  resolve: {
    // Array form, every pattern anchored: `@centraid/design` must not swallow its own subpaths.
    alias: [
      {
        find: /^@centraid\/blueprints\/apps\/_shared\/format-kit$/u,
        replacement: fromHere(
          "../../packages/blueprints/apps/_shared/format-kit.ts"
        ),
      },
      {
        // Subpath, never the barrel: the design root export is reachable from Expo and must stay DOM-free.
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
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
      generateScopedName: "[name]__[local]__[hash:base64:5]",
    },
  },
  build: {
    emptyOutDir: false,
    outDir: "dist/renderer",
    rollupOptions: {
      input: fromHere("../../packages/client/src/react/boot.tsx"),
      output: {
        assetFileNames: "react-[name][extname]",
        chunkFileNames: "react-[name]-[hash].js",
        entryFileNames: "react-boot.js",
      },
    },
    sourcemap: true,
  },
  plugins: [react()],
});
