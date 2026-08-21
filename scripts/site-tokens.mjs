#!/usr/bin/env bun
/**
 * Lower the product design system onto the two public web surfaces.
 *
 * `centraid.dev` (the landing page) and `centraid.dev/docs/` used to carry a
 * design of their own — Fraunces + Newsreader + IBM Plex Mono over a cream
 * paper palette with a teal accent — which meant the first two things a
 * visitor saw of Centraid looked like a different product from the one they
 * then installed. The sites now drink from the SAME emitter the shell drinks
 * from: `toCss()` for the token vocabulary and `toFontFaceCss()` for the one
 * bundled face. There is no second palette and no second type scale.
 *
 * The output is COMMITTED rather than built, because neither site has a build
 * step that could generate it: `scripts/home-site/public` is copied verbatim
 * by `docs-site/assemble.mjs`, and Astro copies `docs-site/public` verbatim
 * too. Committed generator output needs a freshness gate, so this script has
 * two modes — the same shape `packages/design`'s vendored `.woff2` files use:
 *
 *   bun run site:tokens        rewrite the emitted assets
 *   bun run lint:site-tokens   fail if the committed assets are stale
 *
 * The `.woff2` bytes are copied beside each sheet rather than shared from one
 * place, so each site tree stays self-contained: the docs are served both at
 * `/` (locally) and at `/docs/` (production), and a relative `url()` inside
 * `assets/centraid-tokens.css` resolves correctly under both without the
 * base-path juggling an absolute URL would need.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  declaredCustomProps,
  stripCssComments,
  unresolvedVarRefs,
} from "../packages/design/src/css-vars.ts";
import { toCss } from "../packages/design/src/css.ts";
import {
  FONT_FILES,
  toFontFaceCss,
} from "../packages/design/src/font-faces.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FONTS_SRC = path.join(ROOT, "packages/design/fonts");

/**
 * The mark the PRODUCT wears — the PWA's own icon, not a second drawing of
 * it. Both sites carried a teal orbit tile on `#3EC8B4`, a brand hue the v8
 * flip retired (DESIGN.md, "Colors"); `packages/design` has asserted for
 * releases that the emitted CSS contains none of it, while the site artwork
 * kept it. Copying the shipped icon here means the two can never disagree
 * again about what Centraid looks like.
 */
const MARK_SRC = path.join(ROOT, "apps/web/public/centraid.svg");

/** Every public surface that renders in the product's design. Each gets its
 *  own `assets/` copy of the sheet and the faces. */
const SURFACES = [
  path.join(ROOT, "scripts/home-site/public/assets"),
  path.join(ROOT, "scripts/docs-site/public/assets"),
];

/** Relative to the emitted sheet, which lives in `assets/`. */
const FONT_SUBDIR = "fonts";

/** The emitter's own output, exempt from the authored-source checks below. */
const EMITTED_SHEET = "centraid-tokens.css";

/**
 * The site layer that sits between the product tokens and the two
 * stylesheets. It carries only what a long-form PAGE needs and the product
 * shell does not: the reading measure, the section rhythm, and the one
 * sanctioned marketing display step (docs/design-divergences.md). Every value
 * composes from a product token — nothing here introduces a colour, a face, a
 * radius, or a duration of its own.
 */
const SITE_LAYER = `
/* ---------------------------------------------------------------------------
   Site layer — page-scale values the product shell has no use for. Every one
   composes from a token above; see docs/design-divergences.md for the one
   sanctioned step beyond the ramp.
   --------------------------------------------------------------------------- */

/* The theme is the product's, resolved the product's way: no \`data-theme\`
   means "follow the system", and an explicit choice pins it. \`color-scheme\`
   travels with it so form controls, scrollbars and the canvas behind the
   first paint match the tokens instead of the UA default. */
:root {
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
  }
}
[data-theme='light'] {
  color-scheme: light;
}
[data-theme='dark'] {
  color-scheme: dark;
}

:root {
  /* Long-form measure. The reading role's contract is 66ch at the consumer;
     these are that contract spelled once for both sites. */
  --measure-reading: 66ch;
  --measure-lede: 52ch;

  /* Section rhythm. The spacing scale tops out at 32px because that is the
     largest rhythm step INSIDE a product screen; a scrolling page stacks the
     top rung rather than inventing a bigger one. */
  --sp-band: calc(var(--sp-6) * 2);
  --sp-band-lg: calc(var(--sp-6) * 3);
  --sp-band-xl: calc(var(--sp-6) * 4);

  /* The marketing display step: the display ROLE, scaled. Same face, same
     weight, same tracking — only the size moves, and it moves as a multiple
     of the role's own published size token rather than as a second scale. */
  --t-hero-size: clamp(
    calc(var(--t-display-size) * 1.35),
    6vw,
    calc(var(--t-display-size) * 2.25)
  );
  --t-chapter-size: clamp(
    calc(var(--t-display-size) * 1.15),
    4.4vw,
    calc(var(--t-display-size) * 1.6)
  );
}
`;

/** The emitted sheet, in the order a browser needs it: faces, then tokens,
 *  then the site layer that composes over them. */
function sheet() {
  return [
    "/* Centraid — the product design system, lowered onto the public site.",
    " *",
    " * GENERATED by scripts/site-tokens.mjs from @centraid/design. Do not edit",
    " * by hand: `bun run lint:site-tokens` fails on any drift from the emitter,",
    " * and `bun run site:tokens` is the only sanctioned way to change it.",
    " *",
    " * The home page and the docs share this file so neither can grow a palette,",
    " * a face, or a type scale the product does not have.",
    " */",
    "",
    toFontFaceCss(FONT_SUBDIR).trimEnd(),
    "",
    toCss().trimEnd(),
    SITE_LAYER.trimEnd(),
    "",
  ].join("\n");
}

/** What every surface's `assets/` must contain, as `relative path -> bytes`. */
function emitted() {
  const files = new Map([
    [EMITTED_SHEET, Buffer.from(sheet(), "utf8")],
    ["centraid-mark.svg", readFileSync(MARK_SRC)],
  ]);
  for (const file of FONT_FILES) {
    files.set(
      path.posix.join(FONT_SUBDIR, file.fileName),
      readFileSync(path.join(FONTS_SRC, file.fileName))
    );
  }
  return files;
}

/**
 * The three ways the sites drifted, as a gate.
 *
 * `lint:design-tokens` is the zero-debt gate for the client and blueprint
 * stylesheets, and it is not pointed here: the ontology spec sheet still
 * sizes in rem and this pass did not close that out, so adding the directory
 * would mean widening its budget — the one thing that gate exists to
 * prevent. What IS closed, and therefore fenced, is the drift that actually
 * happened: a second type family, a font CDN, and a private set of theme
 * names the product does not have.
 */
const FORBIDDEN = [
  {
    // The whole reason the sites looked like another product.
    label: "a font CDN",
    pattern: /fonts\.(?:googleapis|gstatic)\.com/giu,
    hint: "the bundled face is served from this origin — see assets/centraid-tokens.css",
  },
  {
    label: "a retired site theme name",
    pattern:
      /['"](?:paper|night)['"]\s*(?::|===|==)|data-theme=['"](?:paper|night)['"]/giu,
    hint: "the product's themes are `light` and `dark`; the migration in DocsLayout/docs.js is the only place the old names may appear",
  },
  {
    // A face is a token now. `inherit`, `var(--font-sans)` and
    // `var(--font-code)` are the whole vocabulary. The allowed set is tested
    // on the CAPTURED value rather than inside the pattern: a negative
    // lookahead after `\s*` is defeated by backtracking onto zero whitespace,
    // which passes every declaration it was meant to catch.
    label: "a literal font family",
    pattern: /font-family\s*:\s*(?<value>[^;}]+)/giu,
    allow: (value) =>
      /^(?:inherit|var\(\s*--font-(?:sans|code)\s*\))$/u.test(value.trim()),
    hint: "use var(--font-sans), or var(--font-code) for a command, path or literal",
  },
];

/** Files whose faces and hues the sites author. `.svg` is excluded: a social
 *  card is rasterized by a renderer that has no stylesheet and no webfont, so
 *  it must name a family literally. `.woff2` and the generated sheet are the
 *  emitter's own output, checked above by bytes instead. */
const AUTHORED = /\.(?:css|html|js|astro)$/u;
const SITE_ROOTS = [
  path.join(ROOT, "scripts/home-site"),
  path.join(ROOT, "scripts/docs-site"),
];

function authoredFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      authoredFiles(abs, out);
    } else if (AUTHORED.test(entry.name) && entry.name !== EMITTED_SHEET) {
      out.push(abs);
    }
  }
  return out;
}

const write = process.argv.includes("--write");
const stale = [];

for (const dir of SURFACES) {
  const files = emitted();
  const fontDir = path.join(dir, FONT_SUBDIR);

  if (write) {
    // Remove the font directory first: a face withdrawn upstream must not
    // survive here as an orphan the `@font-face` block no longer names.
    rmSync(fontDir, { force: true, recursive: true });
    mkdirSync(fontDir, { recursive: true });
    for (const [rel, bytes] of files) {
      writeFileSync(path.join(dir, rel), bytes);
    }
    continue;
  }

  for (const [rel, bytes] of files) {
    const abs = path.join(dir, rel);
    let actual;
    try {
      actual = readFileSync(abs);
    } catch {
      stale.push(`${path.relative(ROOT, abs)}: missing`);
      continue;
    }
    if (!actual.equals(bytes)) {
      stale.push(`${path.relative(ROOT, abs)}: differs from the emitter`);
    }
  }

  let present = [];
  try {
    present = readdirSync(fontDir);
  } catch {
    present = [];
  }
  for (const name of present) {
    if (!files.has(path.posix.join(FONT_SUBDIR, name))) {
      stale.push(
        `${path.relative(ROOT, path.join(fontDir, name))}: not emitted by @centraid/design`
      );
    }
  }
}

if (write) {
  console.log(
    `site tokens: emitted ${SURFACES.length} surfaces from @centraid/design`
  );
  process.exit(0);
}

/**
 * Every custom property the two sites can actually resolve: the emitted token
 * sheet, plus whatever each stylesheet declares for itself.
 *
 * A `var(--x)` with NO fallback naming something undeclared is invalid at
 * computed-value time — the declaration is dropped, the property falls back to
 * inherited or initial, nothing throws and nothing logs. That is exactly how
 * `var(--ink-3)` and `var(--night-2)` survived in this tree long after the
 * tokens behind them were renamed, and it is the same class `packages/client`
 * and `packages/blueprints` gate on. The helpers are theirs, imported rather
 * than re-implemented so the three cannot disagree about what counts.
 */
function resolvableProps() {
  const names = new Set(declaredCustomProps(stripCssComments(sheet())));
  for (const root of SITE_ROOTS) {
    for (const file of authoredFiles(root)) {
      if (!file.endsWith(".css")) continue;
      for (const name of declaredCustomProps(
        stripCssComments(readFileSync(file, "utf8"))
      )) {
        names.add(name);
      }
    }
  }
  // Per-instance knobs the markup sets inline on the element itself.
  names.add("--d");
  return names;
}

const resolvable = resolvableProps();
let scanned = 0;
for (const root of SITE_ROOTS) {
  for (const file of authoredFiles(root)) {
    scanned += 1;
    // Comments name what a rule replaced ("was Fraunces"), which is not a
    // live declaration — strip them the way lint-design-tokens.mjs does.
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/<!--[\s\S]*?-->/gu, "");
    for (const name of unresolvedVarRefs(stripCssComments(text), resolvable)) {
      stale.push(
        `${path.relative(ROOT, file)}: ${name} resolves to nothing\n      the declaration is silently dropped — name a token the emitted sheet declares`
      );
    }
    for (const rule of FORBIDDEN) {
      for (const hit of text.matchAll(rule.pattern)) {
        if (rule.allow?.(hit.groups?.value ?? "")) continue;
        stale.push(
          `${path.relative(ROOT, file)}: ${rule.label} — ${hit[0].trim().slice(0, 70)}\n      ${rule.hint}`
        );
      }
    }
  }
}
// A gate that silently scans nothing passes forever; following
// scripts/lint-types.sh, a no-op is a failure.
if (scanned === 0) {
  console.error(
    "site tokens: scanned zero authored files — the gate is broken"
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error("site tokens: the committed site design assets are stale");
  for (const line of stale) console.error(`  x ${line}`);
  console.error("\nRun `bun run site:tokens` to re-emit them.");
  process.exit(1);
}

console.log("site tokens: home + docs match the @centraid/design emitters");
