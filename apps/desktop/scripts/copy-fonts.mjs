#!/usr/bin/env node
/**
 * Stage the vendored `.woff2` faces next to the renderer document (#707).
 *
 * The desktop shell has no network guarantee — it may be started offline, on
 * first run, before any gateway exists — so the four Binding Layer faces have
 * to travel INSIDE the app. `@centraid/design/fonts` owns the bytes and their
 * provenance; this script only places them where the renderer's base URL can
 * reach them: `dist/renderer/fonts/`, matching the relative `FONT_BASE` the
 * preload passes to `toFontFaceCss()`.
 *
 * `electron-builder.yml` packs `dist/**\/*`, so landing them under dist is
 * also what gets them into the signed app — no extraResources entry needed.
 *
 * Copies file-by-file from `FONT_FILES` rather than cloning the directory:
 * the manifest is the contract, so a face that the design package stops
 * declaring stops shipping, and a stray file dropped into the vendored dir
 * never rides along into a release.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { FONT_FILES } from "@centraid/design/font-faces";
import { fontFilePath } from "@centraid/design/fonts";

const root = path.dirname(import.meta.dirname);
const outDir = path.join(root, "dist/renderer/fonts");

mkdirSync(outDir, { recursive: true });
for (const file of FONT_FILES) {
  copyFileSync(fontFilePath(file), path.join(outDir, file.fileName));
}

process.stdout.write(
  `[desktop] staged ${FONT_FILES.length} woff2 faces in dist/renderer/fonts\n`
);
