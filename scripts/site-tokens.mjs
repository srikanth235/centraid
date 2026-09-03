#!/usr/bin/env bun
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

const faceBytes = (fileName) => readFileSync(path.join(FONTS_SRC, fileName));

const MARK_SRC = path.join(ROOT, "apps/web/public/centraid.svg");

const SITE_ROOTS = [
  path.join(ROOT, "scripts/home-site"),
  path.join(ROOT, "scripts/docs-site"),
];
const SURFACES = SITE_ROOTS.map((root) => path.join(root, "public/assets"));

const REPORT_SHEET = path.join(ROOT, "scripts/test-report/report-tokens.css");

const FONT_SUBDIR = "fonts";

const FACE_BASE = "centraid-face";

const EMITTED_SHEET = "centraid-tokens.css";

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

const NIGHT_WATCH_RAMP = `
  ground   #FDFDFC #0E0E0E  ink    #141414 #EDEDEC  ink2   #5A5A58 #9A9A98
  ink3     #6C6C69 #878785  ghost  #757572 #7B7B79  line   #E5E4E1 #232322
  lineS    #EFEEEB #1B1B1A  surf   #F5F4F2 #171716  sunken #F9F8F6 #121211
  danger   #9A3B2E #E08878  attn   #8A5A12 #E5B15E  link   #2D4BA8 #9DB0F0
  ring     #4A67C8 #8098E8  ok     #3E6B45 #7FA886  grey   #8B8A87 #666664
  partial  #175F6A #69B3BD  park   #6B3E8C #C39BD8  gap    #8E2F63 #E094BA  bug #3A3A8C #C2BEEA
  dangerbg #F7EBE8 #241614  attnbg #FAF2E2 #241D0E  okbg   #EDF2EE #151D16
  greybg   #F1F0EE #1A1A19  partialbg #E9F2F3 #0F1E20
  parkbg   #F2ECF8 #1D1726  gapbg  #FAEBF2 #26161F  bugbg  #EEEDF8 #1A1828
`;

const NW_RUNG = /(?<name>\S+) +(?<light>\S+) +(?<dark>\S+)/gu;
function nightWatchDecls(indent, theme) {
  return [...NIGHT_WATCH_RAMP.matchAll(NW_RUNG)]
    .map(({ groups }) => `${indent}--nw-${groups.name}: ${groups[theme]};`)
    .join("\n");
}

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
  if (css.includes(FACE_BASE)) {
    throw new Error(`site tokens: a face URL survived inlining: ${FACE_BASE}`);
  }
  return css;
}

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

const FORBIDDEN = [
  {
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
    label: "a literal font family",
    pattern: /font-family\s*:\s*(?<value>[^;}]+)/giu,
    allow: (value) =>
      /^(?:inherit|var\(\s*--font-(?:sans|code)\s*\))$/u.test(value.trim()),
    hint: "use var(--font-sans), or var(--font-code) for a command, path or literal",
  },
];

const REPORT_FORBIDDEN = [
  ...FORBIDDEN,
  {
    label: "a colour literal",
    pattern: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/gu,
    hint: "name a token: a status takes a --st-* rung, everything else takes the role it means",
  },
  {
    label: "a withdrawn face",
    pattern: /\bInter\b\s*,/gu,
    hint: "the one bundled face is Instrument Sans, reached through var(--font-sans)",
  },
];

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
    rmSync(fontDir, { force: true, recursive: true });
    mkdirSync(fontDir, { recursive: true });
  }

  for (const [rel, bytes] of files) settle(path.join(dir, rel), bytes);

  for (const name of existsSync(fontDir) ? readdirSync(fontDir) : []) {
    if (!files.has(path.posix.join(FONT_SUBDIR, name))) {
      const rel = path.relative(ROOT, path.join(fontDir, name));
      stale.push(`${rel}: not emitted by @centraid/design`);
    }
  }
}

settle(REPORT_SHEET, Buffer.from(reportSheet(), "utf8"));

if (write) {
  console.log(`site tokens: emitted ${SURFACES.length} surfaces + the report`);
  process.exit(0);
}

const SITE_FILES = SITE_ROOTS.flatMap((root) => authoredFiles(root));

const declaredProps = (css) => declaredCustomProps(stripCssComments(css));

function resolvableProps() {
  const names = new Set(["--d", ...declaredProps(sheet())]);
  for (const file of SITE_FILES.filter((f) => f.endsWith(".css"))) {
    for (const name of declaredProps(readFileSync(file, "utf8"))) {
      names.add(name);
    }
  }
  return names;
}

const reportResolvable = new Set([...declaredProps(reportSheet()), "--row"]);

let scanned = 0;

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

for (const name of readdirSync(REPORT_DIR)) {
  if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
  scan(path.join(REPORT_DIR, name), REPORT_FORBIDDEN, reportResolvable);
}

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
