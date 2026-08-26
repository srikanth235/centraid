// NODE-ONLY: `node:path` and `require.resolve`. Import from build-time code
// only — Electron's sandboxed preload cannot resolve `node:path`, and a
// preload that fails to load takes the desktop app with it (#707).
//
// Not on the package barrel (the React Native entry). Reach this at
// `@centraid/design/fonts`. Hosts serve `FONTS_DIR` as static files and inject
// `toFontFaceCss(baseUrl)` from `./font-faces`.

import path from "node:path";

import type { FontFile } from "./font-faces";
import type { BundledFace } from "./typography";

// `__dirname`, not `import.meta.dirname`: this package emits CommonJS.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/** Absolute path to the vendored `.woff2` directory. Hosts serve this; nothing imports the files. */
export const FONTS_DIR: string = path.join(PACKAGE_ROOT, "fonts");

/**
 * Specifiers are written out one per call rather than built from a table: a
 * template-literal specifier is invisible to the dependency graph, and a font
 * package that nothing appears to reference gets pruned.
 */
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

/**
 * Upstream copy inside the `@fontsource` package the lockfile pins. Lives in
 * production code because named provenance of the vendored bytes is the
 * contract, not a test detail.
 */
export function fontSourceFile(file: FontFile): string {
  return path.join(fontSourceRoot(file.genus), "files", file.fileName);
}
