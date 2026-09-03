#!/usr/bin/env node
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
