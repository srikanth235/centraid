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
  existsSync,
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

/** The vendored bytes of one bundled face. */
const faceBytes = (fileName) => readFileSync(path.join(FONTS_SRC, fileName));

/**
 * The mark the PRODUCT wears — the PWA's own icon, not a second drawing of
 * it. Both sites carried a teal orbit tile on `#3EC8B4`, a brand hue the v8
 * flip retired (DESIGN.md, "Colors"); `packages/design` has asserted for
 * releases that the emitted CSS contains none of it, while the site artwork
 * kept it. Copying the shipped icon here means the two can never disagree
 * again about what Centraid looks like.
 */
const MARK_SRC = path.join(ROOT, "apps/web/public/centraid.svg");

/** Every public surface that renders in the product's design: the site tree
 *  whose authored files the gate below reads, and — derived from it, so the two
 *  can never name different sites — its `assets/` copy of the sheet and faces. */
const SITE_ROOTS = [
  path.join(ROOT, "scripts/home-site"),
  path.join(ROOT, "scripts/docs-site"),
];
const SURFACES = SITE_ROOTS.map((root) => path.join(root, "public/assets"));

/**
 * The third public surface, and the one that cannot take an `assets/`
 * directory: the nightly test report (issue #853).
 *
 * `scripts/test-report/generate.mjs` emits ONE self-contained HTML file, and
 * `prepare-pages-site.mjs` publishes the same bytes to two depths — the
 * mutable `test-report/nightly/` alias and the immutable
 * `test-report/nightly/runs/<slug>/` archive beside it. No relative `url()`
 * resolves from both, a root-absolute one would bake in the `/centraid/`
 * Pages base path and break `file://` reading, and an archived run has to keep
 * rendering years after the run that produced it. So this surface gets the
 * whole design system as ONE file with the faces inlined as `data:` URIs,
 * which the node-side generator reads and drops into its `<style>`.
 */
const REPORT_SHEET = path.join(ROOT, "scripts/test-report/report-tokens.css");

/** Relative to the emitted sheet, which lives in `assets/`. */
const FONT_SUBDIR = "fonts";

/**
 * Where `toFontFaceCss` is pointed before the report's bytes are inlined.
 * Nothing ever resolves it: every `url()` built from it is substituted in
 * `facesInline`, and a survivor throws there rather than becoming a request
 * that fails silently in a reader's browser.
 */
const FACE_BASE = "centraid-face";

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

/**
 * The Night Watch palette — the ground, ink, rule and signal values the nightly
 * report's layout is drawn in (issue #862). The status ramp below says what a
 * STATE is; this says what the PAGE is. Bounded the same way the ramp is: see
 * docs/design-divergences.md#the-nightly-test-report. A rung is spelled ONCE, a
 * `name light dark` triple read off by whitespace, so the theme's three blocks
 * cannot drift; the `--nw-` prefix disambiguates from the product tokens
 * (`--line`, `--danger`, `--link`) already in this sheet. Type rungs clear
 * 4.5:1 and mark rungs 3:1 against their surface in both themes;
 * `report-palette.test.mjs` recomputes every pairing off this table.
 *
 * EIGHT tone families, each meaning exactly ONE thing (issue #864): `ok`
 * passed a solid claim; `partial` a partial claim; `danger` tonight went
 * wrong; `flaky` green only on retry; `gap` no test exists; `attn` integrity;
 * `grey` evidence absent; `bug` the product is known-broken (indigo, so a
 * defect cannot share plum with a hole). `partial`/`flaky`/`gap` follow the
 * ramp's identity hues. `attn` moved off the `--seam` literal it used to
 * duplicate (at #B4441F it sat 8° from `danger`, and `--st-gap` pointed at
 * the same value, carrying pending, attention and hole at once).
 */
const NIGHT_WATCH_RAMP = `
  ground   #FDFDFC #0E0E0E  ink    #141414 #EDEDEC  ink2   #5A5A58 #9A9A98
  ink3     #6C6C69 #878785  ghost  #757572 #7B7B79  line   #E5E4E1 #232322
  lineS    #EFEEEB #1B1B1A  surf   #F5F4F2 #171716  sunken #F9F8F6 #121211
  danger   #9A3B2E #E08878  attn   #8A5A12 #E5B15E  link   #2D4BA8 #9DB0F0
  ring     #4A67C8 #8098E8  ok     #3E6B45 #7FA886  grey   #8B8A87 #666664
  partial  #175F6A #69B3BD  flaky  #6B3E8C #C39BD8  gap    #8E2F63 #E094BA  bug #3A3A8C #C2BEEA
  dangerbg #F7EBE8 #241614  attnbg #FAF2E2 #241D0E  okbg   #EDF2EE #151D16
  greybg   #F1F0EE #1A1A19  partialbg #E9F2F3 #0F1E20
  flakybg  #F2ECF8 #1D1726  gapbg  #FAEBF2 #26161F  bugbg  #EEEDF8 #1A1828
`;

/** One theme's rungs, indented to the block that carries them. Spaces only:
 *  a triple can never run past the end of its row. */
const NW_RUNG = /(?<name>\S+) +(?<light>\S+) +(?<dark>\S+)/gu;
function nightWatchDecls(indent, theme) {
  return [...NIGHT_WATCH_RAMP.matchAll(NW_RUNG)]
    .map(({ groups }) => `${indent}--nw-${groups.name}: ${groups[theme]};`)
    .join("\n");
}

/**
 * The report layer — the matrix status ramp, then the Night Watch palette the
 * page's own layout is drawn in, whose dark rungs are spelled twice so a pinned
 * theme and a followed one agree. One template: the second reads the table.
 *
 * The nightly report is a heat map: fifteen surfaces by eleven dimensions, a
 * cell's job being to say which of twelve states it is at a glance. It answers
 * in product tokens — every rung below resolves from one — not in a palette of
 * its own, so the ramp introduces no colour, face or scale, only NAMES, one per
 * state. Each state is named twice, a FILL rung and a TYPE rung, because the two
 * do not always want the same value (the `--c-*` hues carry a solved `-text`
 * sibling); one name per state per role means a rule never has to know which
 * case it is in.
 *
 * A matrix cell paints no fill: it is the state's WORD on a quiet family tint
 * from the Night Watch palette above, so the fill rungs are declared and
 * unpainted while the `-text` half carries the Pages landing page and the
 * briefing's metric words. docs/design-divergences.md bounds both.
 */
const REPORT_LAYER = `
/* ---------------------------------------------------------------------------
   Report layer — the matrix status ramp. One name per state, per role; every
   value resolves from a product token above. See
   docs/design-divergences.md#the-nightly-test-report for what bounds it.
   --------------------------------------------------------------------------- */

:root {
  /* The fill half — one rung per state, declared and currently unpainted. */
  --st-solid: var(--success);
  --st-partial: var(--c-teal);
  --st-failed: var(--danger);
  --st-flaky: var(--c-violet);
  --st-na: var(--c-slate);
  /* \`--seam\` until #864: it resolved to the same literal the Night Watch
     attention rung carried, so one value meant "pending", "attention" and
     "no test exists" at once. \`gap\` takes the rose identity hue instead — the
     family \`--nw-gap\` paints the cells in — so the ramp and the register
     cannot disagree about which hue a hole is. */
  --st-gap: var(--c-rose);
  --st-unmatched: var(--c-amber);
  --st-silent: var(--attention);
  --st-missing: var(--text-faint);
  --st-absent: var(--text-ghost);

  /* The ink a fill carries. \`--text-inv\` is the PAGE colour rather than
     white, and it inverts with the theme exactly as the ramp under it does:
     the identity hues sit at oklch L .50 in light and L .72 in dark, so ink
     on them has to move the other way to hold a label at either theme. */
  --st-on-fill: var(--text-inv);

  /* Type: the same states named on the page ground. The three hue states take
     their solved \`-text\` sibling; the semantic roles are already solved
     against the hardest surface they land on and alias straight through. */
  --st-solid-text: var(--success);
  --st-partial-text: var(--c-teal-text);
  --st-failed-text: var(--danger);
  --st-flaky-text: var(--c-violet-text);
  --st-na-text: var(--c-slate-text);
  --st-gap-text: var(--c-rose-text);
  --st-unmatched-text: var(--c-amber-text);
  --st-silent-text: var(--attention);
  --st-missing-text: var(--text-faint);
  --st-absent-text: var(--text-ghost);

  /* The attention queue's severity bands, worst first. A ladder rather than a
     set: S1 is the consequence tone, S2 the "not yet, and not wrong" tone, S3
     the middle system signal, and S4 recedes into the ink ramp because the
     bottom band's job is to be present without competing. */
  --st-s1: var(--danger);
  --st-s2: var(--seam);
  --st-s3: var(--attention);
  --st-s4: var(--text-soft);

  /* A finding a person pinned, which is not a state the run measured — so it
     takes a content marker rather than any of the semantic roles. */
  --st-pinned: var(--c-indigo-text);

  /* The verdict's middle rung, and the only place \`--warning\` belongs on this
     page: a reading that is DEGRADED. "n/a by design" is not degraded — it is
     an exclusion the app's own manifest declares — which is why it took a
     content marker above instead of sharing this one. In dark the general
     \`--warning\` rung and \`--attention\` land within a hair of each other
     (#d9a75b against #D8A64E), so two states sharing them would be one state
     to any reader. */
  --st-degraded: var(--warning);
  --st-degraded-text: var(--warning);
}

/* ---------------------------------------------------------------------------
   Night Watch layer — the report page's own ground, ink, rules and signal
   tints. One name per rung, both themes; see
   docs/design-divergences.md#the-nightly-test-report for what bounds it.
   --------------------------------------------------------------------------- */

:root {
${nightWatchDecls("  ", "light")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${nightWatchDecls("    ", "dark")}
  }
}

:root[data-theme="dark"] {
${nightWatchDecls("  ", "dark")}
}
`;

/**
 * The bundled faces with their bytes inlined, for the one surface that cannot
 * link them. The RULES still come from \`@centraid/design\` — the weights, the
 * subsets, the \`unicode-range\` split and \`font-display: swap\` are the
 * emitter's, not re-typed here — and only the \`src\` target is rewritten.
 */
function facesInline() {
  let css = toFontFaceCss(FACE_BASE);
  for (const file of FONT_FILES) {
    const from = `url(${FACE_BASE}/${file.fileName})`;
    const b64 = faceBytes(file.fileName).toString("base64");
    const inlined = css.replaceAll(from, `url(data:font/woff2;base64,${b64})`);
    if (inlined === css) {
      throw new Error(`site tokens: ${file.fileName} has no @font-face rule`);
    }
    css = inlined;
  }
  // A survivor would become a request for a path that does not exist.
  if (css.includes(FACE_BASE)) {
    throw new Error(`site tokens: a face URL survived inlining: ${FACE_BASE}`);
  }
  return css;
}

/** The report's sheet: the same tokens and the same site layer the two sites
 *  take, with the faces inlined and the status ramp and the Night Watch
 *  palette composed over them. */
function reportSheet() {
  return [
    "/* Centraid — the product design system, lowered onto the nightly test report.",
    " *",
    " * GENERATED by scripts/site-tokens.mjs from @centraid/design. Do not edit",
    " * by hand: `bun run lint:site-tokens` fails on any drift from the emitter,",
    " * and `bun run site:tokens` is the only sanctioned way to change it.",
    " *",
    " * The faces are inlined because `generate.mjs` emits ONE self-contained",
    " * file that is published at two depths and archived per run; see the",
    " * REPORT_SHEET comment in the emitter for why no href serves both.",
    " */",
    "",
    facesInline().trimEnd(),
    "",
    toCss().trimEnd(),
    SITE_LAYER.trimEnd(),
    REPORT_LAYER.trimEnd(),
    "",
  ].join("\n");
}

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
  return new Map([
    [EMITTED_SHEET, Buffer.from(sheet(), "utf8")],
    ["centraid-mark.svg", readFileSync(MARK_SRC)],
    ...FONT_FILES.map((file) => [
      path.posix.join(FONT_SUBDIR, file.fileName),
      faceBytes(file.fileName),
    ]),
  ]);
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

/**
 * What the report may not carry, on top of the three above.
 *
 * The colour rule is report-only rather than shared. The two sites paint some
 * of their marks in inline SVG inside `index.html`, where a `fill` has to name
 * a colour literally because a social card is rasterized by a renderer with no
 * stylesheet; the report draws no artwork at all — its one SVG is a sparkline
 * whose stroke is a token — so here a literal is always the defect it looks
 * like. Six and eight digits only: `#839` in this tree is an issue number, and
 * a gate that reds on every citation is a gate someone turns off.
 */
const REPORT_FORBIDDEN = [
  ...FORBIDDEN,
  {
    label: "a colour literal",
    pattern: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/gu,
    hint: "name a token: a status takes a --st-* rung, everything else takes the role it means",
  },
  {
    // The face the report shipped for two years, and the one name that proves
    // this migration did not half-land.
    label: "a withdrawn face",
    pattern: /\bInter\b\s*,/gu,
    hint: "the one bundled face is Instrument Sans, reached through var(--font-sans)",
  },
];

/** Files whose faces and hues the sites author. `.svg` is excluded: a social
 *  card is rasterized by a renderer that has no stylesheet and no webfont, so
 *  it must name a family literally. `.woff2` and the generated sheet are the
 *  emitter's own output, checked above by bytes instead. */
const AUTHORED = /\.(?:css|html|js|astro)$/u;
const REPORT_DIR = path.dirname(REPORT_SHEET);

function authoredFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const { name } = entry;
    if (name === "node_modules" || name === "dist") continue;
    const abs = path.join(dir, name);
    if (entry.isDirectory()) authoredFiles(abs, out);
    else if (AUTHORED.test(name) && name !== EMITTED_SHEET) out.push(abs);
  }
  return out;
}

const write = process.argv.includes("--write");
const stale = [];

/** One emitted artifact, on the terms every one of them takes: written under
 *  `--write`, and otherwise compared to the committed bytes so a hand edit or
 *  a stale commit is named rather than silently served. */
function settle(abs, bytes) {
  const rel = path.relative(ROOT, abs);
  if (write) {
    writeFileSync(abs, bytes);
  } else if (!existsSync(abs)) {
    stale.push(`${rel}: missing`);
  } else if (!readFileSync(abs).equals(bytes)) {
    stale.push(`${rel}: differs from the emitter`);
  }
}

for (const dir of SURFACES) {
  const files = emitted();
  const fontDir = path.join(dir, FONT_SUBDIR);

  if (write) {
    // Remove the font directory first: a face withdrawn upstream must not
    // survive here as an orphan the `@font-face` block no longer names.
    rmSync(fontDir, { force: true, recursive: true });
    mkdirSync(fontDir, { recursive: true });
  }

  for (const [rel, bytes] of files) settle(path.join(dir, rel), bytes);

  // Whatever else the directory holds; empty under `--write`, which rebuilt it.
  for (const name of existsSync(fontDir) ? readdirSync(fontDir) : []) {
    if (!files.has(path.posix.join(FONT_SUBDIR, name))) {
      const rel = path.relative(ROOT, path.join(fontDir, name));
      stale.push(`${rel}: not emitted by @centraid/design`);
    }
  }
}

// The report's single file, on the same terms.
settle(REPORT_SHEET, Buffer.from(reportSheet(), "utf8"));

if (write) {
  console.log(`site tokens: emitted ${SURFACES.length} surfaces + the report`);
  process.exit(0);
}

/** Both site trees walked once: the gate reads this list twice, and a second
 *  walk could see a tree the first half of the gate never vetted. */
const SITE_FILES = SITE_ROOTS.flatMap((root) => authoredFiles(root));

/** The custom properties a stylesheet declares, a commented-out one excepted. */
const declaredProps = (css) => declaredCustomProps(stripCssComments(css));

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
  // `--d` is a per-instance knob the markup sets inline on the element itself.
  const names = new Set(["--d", ...declaredProps(sheet())]);
  for (const file of SITE_FILES.filter((f) => f.endsWith(".css"))) {
    for (const name of declaredProps(readFileSync(file, "utf8"))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Every custom property the report can resolve. Its whole vocabulary is the
 * emitted sheet — it authors no stylesheet of its own — plus the one knob the
 * markup sets per element: `--row` staggers a matrix row's entry animation and
 * is written as an inline `style` on the cell, so it is declared where it is
 * used rather than in the sheet.
 */
const reportResolvable = new Set([...declaredProps(reportSheet()), "--row"]);

let scanned = 0;

/** Read a file the way lint-design-tokens.mjs does — comments name what a rule
 *  replaced ("was Inter"), which is not a live declaration — and record every
 *  unresolvable reference and every forbidden construct it still carries. */
function scan(file, rules, resolvable) {
  scanned += 1;
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  for (const name of unresolvedVarRefs(stripCssComments(text), resolvable)) {
    stale.push(
      `${path.relative(ROOT, file)}: ${name} resolves to nothing\n      the declaration is silently dropped — name a token the emitted sheet declares`
    );
  }
  for (const rule of rules) {
    for (const hit of text.matchAll(rule.pattern)) {
      if (rule.allow?.(hit.groups?.value ?? "")) continue;
      stale.push(
        `${path.relative(ROOT, file)}: ${rule.label} — ${hit[0].trim().slice(0, 70)}\n      ${rule.hint}`
      );
    }
  }
}

const resolvable = resolvableProps();
for (const file of SITE_FILES) scan(file, FORBIDDEN, resolvable);

// The report authors its CSS inside `.mjs` template literals rather than in a
// stylesheet, so the scan is pointed at the modules that carry it. Tests are
// excluded: a test asserting that a literal is REJECTED has to spell one.
for (const name of readdirSync(REPORT_DIR)) {
  if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
  scan(path.join(REPORT_DIR, name), REPORT_FORBIDDEN, reportResolvable);
}

// A gate that silently scans nothing passes forever; following
// scripts/lint-types.sh, a no-op is a failure.
if (scanned === 0) {
  console.error("site tokens: scanned zero files — the gate is broken");
  process.exit(1);
}

if (stale.length > 0) {
  console.error("site tokens: the committed site design assets are stale");
  for (const line of stale) console.error(`  x ${line}`);
  console.error("\nRun `bun run site:tokens` to re-emit them.");
  process.exit(1);
}

console.log("site tokens: home + docs + the report match @centraid/design");
