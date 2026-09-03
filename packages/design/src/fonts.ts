import path from "node:path";

import type { FontFile } from "./font-faces";
import type { BundledFace } from "./typography";

const PACKAGE_ROOT = path.resolve(__dirname, "..");

export const FONTS_DIR: string = path.join(PACKAGE_ROOT, "fonts");

const fontSourceRoot = (genus: BundledFace): string => {
  switch (genus) {
    case "sans":
      return path.dirname(
        require.resolve("@fontsource/instrument-sans/package.json")
      );
  }
};

export function fontFilePath(file: FontFile): string {
  return path.join(FONTS_DIR, file.fileName);
}

export function fontSourceFile(file: FontFile): string {
  return path.join(fontSourceRoot(file.genus), "files", file.fileName);
}
