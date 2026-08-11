// Centraid — where the vendored `.woff2` bytes live on disk.
//
// This module is NODE-ONLY: it reaches for `node:path` and `require.resolve`,
// so it may only be imported by build scripts and other build-time code. The
// browser-safe half of the seam — the file list, the subset ranges, and the
// `@font-face` emitter — lives in `./font-faces`, and that is what a renderer,
// a preload, or an app surface imports. Electron's sandboxed preload cannot
// resolve `node:path` at all, and a preload that fails to load takes the whole
// desktop app with it (issue #707).
//
// This module mirrors `kit.ts`. The kit is SERVED, not imported, and so are
// the fonts: what the rest of the repo needs from this layer is a PATH, not a
// module to bundle. Hosts pass `FONTS_DIR` to their static server and inject
// `toFontFaceCss(baseUrl)` from `./font-faces`.
//
// The `.woff2` files under `../fonts` are vendored copies of the `@fontsource`
// packages this package depends on — `fontSourceFile()` resolves the upstream
// original, and `fonts.test.ts` compares the bytes, so a vendored file cannot
// drift from the version the lockfile pins.
//
// NOT re-exported from the package barrel: the barrel is the React Native
// entry point, and `node:path` plus `require.resolve` have no meaning there.
// Reach this at `@centraid/design/fonts`, the way `./kit` is reached.

import path from "node:path";

import type { FontFile } from "./font-faces";
import type { FontFamily } from "./typography";

// `__dirname`, not `import.meta.dirname`: this package emits CommonJS.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

/**
 * Absolute path to the vendored `.woff2` directory. Hosts serve this as a
 * static directory; nothing imports the files.
 */
export const FONTS_DIR: string = path.join(PACKAGE_ROOT, "fonts");

/**
 * The upstream package each genus is vendored from, resolved lazily so
 * importing this module never depends on a node_modules layout.
 *
 * The specifiers are written out one per call rather than built from a table:
 * a template-literal specifier is invisible to the dependency graph, and a
 * font package that nothing appears to reference gets pruned — taking the
 * provenance of the vendored bytes with it.
 */
const fontSourceRoot = (genus: FontFamily): string => {
  switch (genus) {
    case "display":
      return path.dirname(
        require.resolve("@fontsource/instrument-serif/package.json")
      );
    case "mono":
      return path.dirname(
        require.resolve("@fontsource/spline-sans-mono/package.json")
      );
    case "sans":
      return path.dirname(
        require.resolve("@fontsource/schibsted-grotesk/package.json")
      );
    case "serif":
      return path.dirname(
        require.resolve("@fontsource/source-serif-4/package.json")
      );
  }
};

/** Absolute path to one vendored file. */
export function fontFilePath(file: FontFile): string {
  return path.join(FONTS_DIR, file.fileName);
}

/**
 * Absolute path to the UPSTREAM copy of one vendored file, inside the
 * `@fontsource` package the lockfile pins. The only caller is the freshness
 * test — but it lives here, in production code, because the vendored bytes
 * having a named provenance is part of the contract, not part of the test.
 */
export function fontSourceFile(file: FontFile): string {
  return path.join(fontSourceRoot(file.genus), "files", file.fileName);
}
