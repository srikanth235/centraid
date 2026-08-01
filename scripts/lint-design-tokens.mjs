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

/** The two-weight chrome rule (DESIGN.md, typography.ts):
 * 400 + 500/600. `normal` is 400. 700 exists only in `marketingType`, which
 * is web-only and outside the chrome — so it counts as debt here. */
const SANCTIONED_WEIGHTS = new Set(["400", "500", "600", "normal", "inherit"]);

const declarations = (css, property) => [
  ...css.matchAll(
    new RegExp(String.raw`${property}\s*:\s*(?<value>[^;}]+)`, "giu")
  ),
];

const isTokened = (value) => value.includes("var(--");

/** `--t-*` are `font` **shorthands**, not sizes, so *every* `font-size`
 * declaration with a length is off-contract — `font-size: var(--t-body)`
 * silently drops the whole shorthand. Carve-outs: `inherit` (explicit
 * cascade) and any `var(...)` (a surface-local sizing knob). */
function countRawFontSize(css) {
  return declarations(css, "font-size").filter((match) => {
    const value = match.groups?.value.trim() ?? "";
    return value !== "inherit" && !isTokened(value);
  }).length;
}

function countRawFontWeight(css) {
  return declarations(css, "font-weight").filter((match) => {
    const value = (match.groups?.value ?? "")
      .replace(/!important/giu, "")
      .trim();
    return !SANCTIONED_WEIGHTS.has(value) && !isTokened(value);
  }).length;
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
    `${totals.paletteHueAsText} palette-hue-as-text`
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
