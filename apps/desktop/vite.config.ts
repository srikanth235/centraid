import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const fromHere = (p: string): string =>
  fileURLToPath(new URL(p, import.meta.url));

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

export default defineConfig({
  base: "./",
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
