// Centraid — the four bundled faces, and the seam that serves them.
//
// The Binding Layer names four real faces (Instrument Sans, Instrument Serif,
// Source Serif 4, DM Mono) rather than system stacks, so the product has to
// SHIP them: an app surface behind a strict CSP cannot fetch a CDN, a desktop
// build has no network guarantee at all, and a face that silently falls back
// to the UA default takes the product's signature with it.
//
// This module mirrors `kit.ts`. The kit is SERVED, not imported, and so are
// the fonts: what the rest of the repo needs from this layer is a PATH plus
// the `@font-face` rules that point at it, not a module to bundle. Hosts pass
// `FONTS_DIR` to their static server and inject `toFontFaceCss(baseUrl)`.
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

import { fonts } from "./typography";
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
      return path.dirname(require.resolve("@fontsource/dm-mono/package.json"));
    case "sans":
      return path.dirname(
        require.resolve("@fontsource/instrument-sans/package.json")
      );
    case "serif":
      return path.dirname(
        require.resolve("@fontsource/source-serif-4/package.json")
      );
  }
};

/** Filename stem of each vendored face, matching the upstream convention. */
const FONT_SLUG = {
  display: "instrument-serif",
  mono: "dm-mono",
  sans: "instrument-sans",
  serif: "source-serif-4",
} as const satisfies Record<FontFamily, string>;

export type FontSubset = "latin" | "latin-ext";

/**
 * The Unicode coverage of each subset, copied from the upstream `unicode.json`
 * so a browser downloads `latin-ext` only when a page actually needs it.
 */
export const FONT_SUBSET_RANGE = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const satisfies Record<FontSubset, string>;

export interface FontFile {
  /** The type-scale genus this file serves (`--font-<genus>`). */
  genus: FontFamily;
  /** The CSS `font-family` name, as the type scale spells it. */
  family: string;
  weight: 400 | 500;
  subset: FontSubset;
  /** File name inside `FONTS_DIR`. */
  fileName: string;
}

/**
 * Every vendored file, and only those. The ramp uses exactly two weights, and
 * only the sans carries both: the display serif, the reading serif and the
 * mono are 400-only roles, so shipping their 500s would be dead bytes on
 * every first paint.
 */
export const FONT_FILES: readonly FontFile[] = (
  [
    ["sans", 400],
    ["sans", 500],
    ["display", 400],
    ["serif", 400],
    ["mono", 400],
  ] as const
).flatMap(([genus, weight]) =>
  (["latin", "latin-ext"] as const).map((subset) => ({
    family: fonts[genus],
    fileName: `${FONT_SLUG[genus]}-${subset}-${weight}-normal.woff2`,
    genus,
    subset,
    weight,
  }))
);

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

/**
 * The `@font-face` block for the bundled faces, pointing at `baseUrl`.
 *
 * `font-display: swap` is deliberate: the fallback stacks in `fontStacks`
 * carry the CJK coverage none of these four faces has, so a blocking swap
 * period would show nothing at all to the readers who need the fallback most.
 */
export function toFontFaceCss(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const lines = ["/* Generated by @centraid/design — do not edit by hand. */"];
  for (const file of FONT_FILES) {
    lines.push(
      "@font-face {",
      `  font-family: '${file.family}';`,
      "  font-style: normal;",
      "  font-display: swap;",
      `  font-weight: ${file.weight};`,
      `  src: url(${base}/${file.fileName}) format('woff2');`,
      `  unicode-range: ${FONT_SUBSET_RANGE[file.subset]};`,
      "}"
    );
  }
  return `${lines.join("\n")}\n`;
}
