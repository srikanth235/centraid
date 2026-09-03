#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { readLedgerSection, writeLedgerSection } from "./check-ledgers.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGETS = [
  "packages/client/src",
  "packages/blueprints/apps",
  "packages/design/src/elements",
  "apps/web/src",
  "apps/extension/static",
];
const BUDGET_FILE = path.join(ROOT, "tests/budgets.json");
const BUDGET_SECTION = "designTokenCss";
const BUDGET_SECTION_PATH = "tests/budgets.json";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

export const METRICS = [
  "rawHex",
  "literalFontFamily",
  "rawFontSize",
  "rawFontWeight",
  "rawRadius",
  "paletteHueAsText",
  "retiredTypeAxis",
];

const PALETTE_HUES = "amber|forest|indigo|ochre|rose|slate|teal|violet";

function countPaletteHueAsText(css) {
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

const SANCTIONED_WEIGHTS = new Set(["400", "600", "normal", "inherit"]);

const declarations = (css, property) => [
  ...css.matchAll(
    new RegExp(String.raw`${property}\s*:\s*(?<value>[^;}]+)`, "giu")
  ),
];

const isTokened = (value) => value.includes("var(--");

const TYPE_ROLE_NAMES =
  "display|title|reading|body|body-strong|label-on|small|small-strong|control|eyebrow|mono|annot-label|annot-label-on|band";
const TYPE_ROLE = new RegExp(
  String.raw`var\(\s*--t-(?:${TYPE_ROLE_NAMES})\s*\)`,
  "u"
);
const TYPE_SIZE_ROLE = new RegExp(
  String.raw`var\(\s*--t-(?:${TYPE_ROLE_NAMES})-size\s*\)`,
  "u"
);

const SHORTHAND_AS_SIZE = /var\(\s*--t-(?!.*-size\s*[),])[\w-]+\s*[),]/u;

function countRawFontSize(css) {
  const longhands = declarations(css, "font-size").filter((match) => {
    const value = match.groups?.value.trim() ?? "";
    if (SHORTHAND_AS_SIZE.test(value)) return true;
    return value !== "inherit" && !TYPE_SIZE_ROLE.test(value);
  }).length;
  const shorthands = declarations(css, "font").filter((match) => {
    const value = match.groups?.value.trim() ?? "";
    return value !== "inherit" && !TYPE_ROLE.test(value);
  }).length;
  return longhands + shorthands;
}

function countRawFontWeight(css) {
  const declarationsWithWeight = declarations(css, "font-weight").filter(
    (match) => {
      const value = (match.groups?.value ?? "")
        .replace(/!important/giu, "")
        .trim();
      return !SANCTIONED_WEIGHTS.has(value) && !isTokened(value);
    }
  ).length;
  const shorthandWeights = declarations(css, "font").filter((match) => {
    const first = (match.groups?.value ?? "").trim().split(/\s+/u)[0] ?? "";
    return /^\d{3}$/u.test(first) && !SANCTIONED_WEIGHTS.has(first);
  }).length;
  return declarationsWithWeight + shorthandWeights;
}

function countRawRadius(css) {
  const matches = [
    ...declarations(css, "border-radius"),
    ...declarations(css, "border-top-left-radius"),
    ...declarations(css, "border-top-right-radius"),
    ...declarations(css, "border-bottom-left-radius"),
    ...declarations(css, "border-bottom-right-radius"),
  ];
  const allowedToken =
    /var\(\s*--r-(?:xs|sm|md|lg|pill)\s*\)|var\(\s*--tile-(?:radius|icon-radius)(?:\s*,\s*var\(\s*--r-lg\s*\))?\s*\)|var\(\s*--chip-radius\s*,\s*var\(\s*--r-md\s*\)\s*\)/gu;
  return matches.filter((match) => {
    const value = (match.groups?.value ?? "")
      .replace(/!important/giu, "")
      .trim();
    if (value === "inherit" || value === "26%") return false;
    const residue = value.replace(allowedToken, "").trim();
    return residue.length > 0;
  }).length;
}

export function analyzeCss(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rawHex = [...stripped.matchAll(/#[\da-f]{3,8}\b/giu)].length;
  const literalFontFamily = [
    ...stripped.matchAll(/font-family\s*:\s*(?<value>[^;]+);/giu),
  ].filter((match) => {
    const value = match.groups?.value.trim() ?? "";
    return !/^(?:inherit|var\(\s*--font-(?:sans|code)\s*\))$/u.test(value);
  }).length;
  return {
    rawHex,
    literalFontFamily,
    rawFontSize: countRawFontSize(stripped),
    rawFontWeight: countRawFontWeight(stripped),
    rawRadius: countRawRadius(stripped),
    paletteHueAsText: countPaletteHueAsText(stripped),
    retiredTypeAxis: [
      ...stripped.matchAll(
        /--font-(?:mono|serif)\b|--page-margin-compact\b|data-app-font\b/giu
      ),
    ].length,
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
          )}#${BUDGET_SECTION}`
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
    `${totals.paletteHueAsText} palette-hue-as-text` +
    `, ${totals.retiredTypeAxis} retired type-axis use(s)`
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
    writeLedgerSection(BUDGET_SECTION_PATH, BUDGET_SECTION, {
      ...readLedgerSection(BUDGET_SECTION_PATH, BUDGET_SECTION),
      budgets: sorted,
    });
    console.log(
      `ok   design-token-css — budget rewritten: ${formatTotals(actual)}`
    );
    return;
  }
  const budget =
    readLedgerSection(BUDGET_SECTION_PATH, BUDGET_SECTION)?.budgets ?? {};
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
