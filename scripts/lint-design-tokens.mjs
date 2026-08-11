#!/usr/bin/env node
// Design-token ratchet (#630 Wave 0; type/radius counters added by #686 B2).
//
// Raw hex colors and literal font-family stacks in client/blueprint CSS are
// design-system forks. Existing debt is explicit in the checked-in budget;
// every decrease must tighten that budget, every increase fails, and new CSS
// files start at zero. Comments are stripped so issue references such as #505
// are not mistaken for colors.
//
// Run with `--write` to rewrite the budget from the current tree (the only
// sanctioned way to record a decrease).
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGETS = [
  "packages/client/src",
  "packages/blueprints/apps",
  "packages/design/kit",
  "apps/web/src",
  "apps/extension/static",
];
const BUDGET_FILE = path.join(ROOT, "tests/design-token-css-budget.json");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

export const METRICS = [
  "rawHex",
  "literalFontFamily",
  "rawFontSize",
  "rawFontWeight",
  "rawRadius",
  "paletteHueAsText",
  "typeSizeRung",
  "roleModifierGap",
];

/** The eight app-icon hues (`palette.ts`). Kept as a literal list rather than
 * imported so this script stays a dependency-free .mjs the pre-commit hook can
 * run before any package is built. */
const PALETTE_HUES = "amber|forest|indigo|ochre|rose|slate|teal|violet";

/** `--c-<hue>` is an icon FILL. As `color:` on the shell's own surfaces the
 * fills measure 2.04–5.03:1 on light and 3.12–8.44:1 on dark — 17 of 32 cells
 * below AA, and amber misses even the 3:1 non-text floor. The solved rung
 * `--c-<hue>-text` exists for type, so a `color:` (or its `-webkit-` fill
 * twin) that names a bare hue is off-contract.
 *
 * Reach and limits: this sees the `color:` declaration itself, including one
 * wrapped in `color-mix()`. It cannot see a hue laundered through an
 * intermediate custom property (`--au-hue: var(--c-rose)` then
 * `color: var(--au-hue)`) — that indirection is what the split
 * fill/ink variable pairs in the client exist to keep honest, and what the
 * `--c-*-text` grids in packages/design/src/contrast.test.ts measure. */
function countPaletteHueAsText(css) {
  // `declarations()` has no left boundary, so it cannot be reused here:
  // `color` is a suffix of `background-color`, `border-color`,
  // `border-top-color`… all of which are FILLS and stay on the raw hue.
  const ink =
    /(?<![\w-])(?:color|-webkit-text-fill-color)\s*:\s*(?<value>[^;}]+)/giu;
  const bare = new RegExp(
    String.raw`var\(\s*--c-(?:${PALETTE_HUES})\s*[),]`,
    "u"
  );
  return [...css.matchAll(ink)].filter((match) =>
    bare.test(match.groups?.value ?? "")
  ).length;
}

/** The two-register rule (DESIGN.md, typography.ts): the sans draws at 500
 * (regular) and 600 (strong); the serifs and the mono are 400-only, `normal`
 * being 400. Nothing else — 600 is not a near-miss, it is a weight with no
 * file behind it. `font-faces.ts` types every vendored face's weight and
 * vendors exactly those instances, so a rule asking for anything off this
 * set gets SYNTHESISED bold: the browser smears the nearest outline outward.
 * That reads muddy rather than strong, and it is worse than the real
 * instance it was reaching past.
 *
 * "600" is sanctioned only because the sans now VENDORS that cut as its
 * strong register. It was previously banned for the opposite reason — 245
 * declarations had accumulated against a file nobody shipped, while the gate
 * reported zero regressions. Adding a weight here is only ever correct if
 * `font-faces.ts` vendors the file too. */
const SANCTIONED_WEIGHTS = new Set(["400", "500", "600", "normal", "inherit"]);

const declarations = (css, property) => [
  ...css.matchAll(
    new RegExp(String.raw`${property}\s*:\s*(?<value>[^;}]+)`, "giu")
  ),
];

const isTokened = (value) => value.includes("var(--");

/** A `--t-<key>` is a `font` **shorthand** — family, weight, size and
 * line-height at once — so it cannot serve a rule that wants only the size.
 * `--t-<key>-size` is the composable rung that can (#686, typography.ts), and
 * it is the sanctioned form here. A length literal is still debt.
 *
 * Carve-outs: `inherit` (an explicit cascade decision) and any `var(...)` (the
 * size rungs plus surface-local sizing knobs).
 *
 * Counted DESPITE being a `var()`: `font-size: var(--t-body)`. That names the
 * shorthand where a size belongs; the declaration is invalid and is dropped
 * whole, so the element silently keeps its inherited size. Nothing throws and
 * nothing logs — exactly the failure the `-size` rungs exist to prevent, so it
 * must not hide inside the `var()` carve-out. */
const SHORTHAND_AS_SIZE = /var\(\s*--t-(?!.*-size\s*[),])[\w-]+\s*[),]/u;

function countRawFontSize(css) {
  return declarations(css, "font-size").filter((match) => {
    const value = match.groups?.value.trim() ?? "";
    if (SHORTHAND_AS_SIZE.test(value)) return true;
    return value !== "inherit" && !isTokened(value);
  }).length;
}

function countRawFontWeight(css) {
  const longhand = declarations(css, "font-weight").filter((match) => {
    const value = (match.groups?.value ?? "")
      .replace(/!important/giu, "")
      .trim();
    return !SANCTIONED_WEIGHTS.has(value) && !isTokened(value);
  }).length;
  // A hand-rolled `font:` shorthand states the weight in its first slot, where
  // no `font-weight` declaration exists for the loop above to find. That blind
  // spot is how `font: 600 14px var(--font-sans)` sat on the shell's own action
  // button while the gate reported zero off-scale weights.
  const shorthand = [
    ...css.matchAll(/(?<![\w-])font\s*:\s*(?<value>[^;}]+)/giu),
  ].filter((match) => {
    const first = (match.groups?.value ?? "").trim().split(/[\s/]+/u)[0];
    return /^\d+$/u.test(first) && !SANCTIONED_WEIGHTS.has(first);
  }).length;
  return longhand + shorthand;
}

/** One count per `border-radius` declaration that carries an off-scale px
 * component. The scale is `--r-xs|sm|md|lg|xl` = 2/4/6/10/14px. Carve-outs,
 * because none of them are points on that scale:
 *   - `0` / `inherit`      — a reset, not a radius
 *   - any `%` (e.g. `50%`) — circle/ellipse geometry
 *   - `>= 99px`            — the pill idiom radii.ts documents as composed
 *                            inline ("a pill on FABs")
 *   - `1px`                — sub-`xs` optical nudge so an inner edge matches
 *                            an outer radius minus its hairline border
 *   - `var(...)`/`calc(var(...))` — already tokened */
function countRawRadius(css) {
  return declarations(css, "border-radius").filter((match) => {
    const value = (match.groups?.value ?? "")
      .replace(/!important/giu, "")
      .trim();
    if (isTokened(value)) return false;
    return value.split(/[\s/]+/u).some((part) => {
      const px = /^(?<n>\d+(?:\.\d+)?)px$/u.exec(part);
      if (!px) return false;
      const n = Number(px.groups?.n);
      return n !== 1 && n < 99;
    });
  }).length;
}

/** A `--t-<role>-size` rung taken on its own.
 *
 * The rung is a SIZE. `--t-<role>` is the role — weight, leading and family
 * travel with it. Reaching for the rung gets the size while the other three
 * fall back to whatever an ancestor happened to set, which is how the shell
 * ended up rendering its own 20/26/500 headline at 400 with `normal` leading.
 * Native cannot express this at all: `t(role)` is the only entry point there,
 * and it returns the whole style. This metric is the web's stand-in for that
 * constraint — a ratchet, because the rung has ~540 legitimate-looking uses
 * that each need a human to pick the right role.
 *
 * Not counted: a block that also states `font-family`/`font-weight`/
 * `line-height`, or composes a role class. Those have made a deliberate choice
 * rather than inheriting one by accident. */
function countTypeSizeRung(css) {
  let n = 0;
  for (const match of css.matchAll(/\{(?<body>[^{}]*)\}/gu)) {
    const body = match.groups?.body ?? "";
    if (!/font-size\s*:\s*var\(\s*--t-[a-z-]+-size\s*\)/u.test(body)) continue;
    if (
      /font-family\s*:|font-weight\s*:|line-height\s*:|\bfont\s*:|composes\s*:/u.test(
        body
      )
    )
      continue;
    n += 1;
  }
  return n;
}

/** The modifiers a role owns but the `font` shorthand has no slot for.
 *
 * `typeModifiers` in typography.ts says a surface "cannot get one without the
 * rest by accident" — true on native, where `t()` returns them together, and
 * false on web until it was measured: 117 blocks took a role and dropped a
 * modifier, so "numerics are mono and tabular in every app, without exception"
 * was untrue in 20 places and "a number reads in order under RTL" in 103.
 *
 * `direction`/`unicode-bidi` are asked of TEXT elements only — the same
 * carve-out `typeModifiers` documents, since a layout container carrying the
 * numeric face would flip its own inline axis with it. */
const ROLE_MODIFIERS = {
  display: [["letter-spacing", false]],
  eyebrow: [
    ["letter-spacing", false],
    ["text-transform", false],
  ],
  mono: [
    ["font-variant-numeric", false],
    ["direction", true],
    ["unicode-bidi", true],
  ],
};

function countRoleModifierGap(css) {
  let n = 0;
  for (const match of css.matchAll(/\{(?<body>[^{}]*)\}/gu)) {
    const body = match.groups?.body ?? "";
    const isContainer = /display\s*:\s*(?:inline-)?(?:flex|grid)/u.test(body);
    for (const [role, mods] of Object.entries(ROLE_MODIFIERS)) {
      if (
        !new RegExp(String.raw`font\s*:\s*var\(\s*--t-${role}\s*\)`, "u").test(
          body
        )
      )
        continue;
      for (const [property, textOnly] of mods) {
        if (textOnly && isContainer) continue;
        if (!new RegExp(String.raw`(?:^|[\s;])${property}\s*:`, "u").test(body))
          n += 1;
      }
    }
  }
  return n;
}

export function analyzeCss(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rawHex = [...stripped.matchAll(/#[\da-f]{3,8}\b/giu)].length;
  const literalFontFamily = [
    ...stripped.matchAll(/font-family\s*:\s*(?<value>[^;]+);/giu),
  ].filter((match) => !match.groups?.value.trim().startsWith("var(--")).length;
  return {
    rawHex,
    literalFontFamily,
    rawFontSize: countRawFontSize(stripped),
    rawFontWeight: countRawFontWeight(stripped),
    rawRadius: countRawRadius(stripped),
    paletteHueAsText: countPaletteHueAsText(stripped),
    typeSizeRung: countTypeSizeRung(stripped),
    roleModifierGap: countRoleModifierGap(stripped),
  };
}

function walkCss(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walkCss(absolute, out);
    else if (absolute.endsWith(".css")) out.push(absolute);
  }
  return out;
}

export function compareBudget(actual, budget) {
  const findings = [];
  for (const [file, counts] of Object.entries(actual)) {
    const allowed = budget[file] ?? {};
    for (const metric of METRICS) {
      const found = counts[metric] ?? 0;
      const limit = allowed[metric] ?? 0;
      if (found > limit)
        findings.push(`${file}: ${metric} increased ${limit} → ${found}`);
      else if (found < limit)
        findings.push(
          `${file}: ${metric} fell ${limit} → ${found}; tighten ${path.relative(
            ROOT,
            BUDGET_FILE
          )}`
        );
    }
  }
  for (const file of Object.keys(budget)) {
    if (!(file in actual))
      findings.push(`${file}: stale budget entry (file removed or moved)`);
  }
  return findings;
}

export function scanDesignTokenCss(root = ROOT) {
  const actual = {};
  for (const target of TARGETS) {
    const directory = path.join(root, target);
    if (!existsSync(directory))
      throw new Error(`design-token lint target does not exist: ${target}`);
    for (const absolute of walkCss(directory)) {
      const counts = analyzeCss(readFileSync(absolute, "utf8"));
      const recorded = Object.fromEntries(
        METRICS.filter((metric) => counts[metric] > 0).map((metric) => [
          metric,
          counts[metric],
        ])
      );
      if (Object.keys(recorded).length > 0)
        actual[path.relative(root, absolute)] = recorded;
    }
  }
  return actual;
}

export function formatTotals(actual) {
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, 0]));
  for (const counts of Object.values(actual))
    for (const metric of METRICS) totals[metric] += counts[metric] ?? 0;
  return (
    `${totals.rawHex} grandfathered hex value(s), ` +
    `${totals.literalFontFamily} literal font stack(s), ` +
    `${totals.rawFontSize} raw font-size(s), ` +
    `${totals.rawFontWeight} off-scale font-weight(s), ` +
    `${totals.rawRadius} raw border-radius(es), ` +
    `${totals.paletteHueAsText} palette-hue-as-text, ` +
    `${totals.typeSizeRung} bare size rung(s), ` +
    `${totals.roleModifierGap} role(s) missing a modifier`
  );
}

function main() {
  const actual = scanDesignTokenCss();
  if (process.argv.includes("--write")) {
    const sorted = Object.fromEntries(
      Object.keys(actual)
        .sort()
        .map((file) => [file, actual[file]])
    );
    writeFileSync(BUDGET_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(
      `ok   design-token-css — budget rewritten: ${formatTotals(actual)}`
    );
    return;
  }
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  const findings = compareBudget(actual, budget);
  if (findings.length > 0) {
    console.error(
      `FAIL — design-token CSS ratchet found ${findings.length} mismatch(es):`
    );
    for (const finding of findings.sort()) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `ok   design-token-css — ${formatTotals(actual)}, zero regressions`
  );
}

if (process.argv[1] === import.meta.filename) main();
