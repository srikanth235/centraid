#!/usr/bin/env node
// Design-token ratchet (#630 Wave 0).
//
// Raw hex colors and literal font-family stacks in client/blueprint CSS are
// design-system forks. Existing debt is explicit in the checked-in budget;
// every decrease must tighten that budget, every increase fails, and new CSS
// files start at zero. Comments are stripped so issue references such as #505
// are not mistaken for colors.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGETS = [
  "packages/client/src",
  "packages/blueprints/apps",
  "packages/design/kit",
];
const BUDGET_FILE = path.join(ROOT, "tests/design-token-css-budget.json");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

export function analyzeCss(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rawHex = [...stripped.matchAll(/#[\da-f]{3,8}\b/giu)].length;
  const literalFontFamily = [
    ...stripped.matchAll(/font-family\s*:\s*(?<value>[^;]+);/giu),
  ].filter((match) => !match.groups?.value.trim().startsWith("var(--")).length;
  return { rawHex, literalFontFamily };
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
    for (const metric of ["rawHex", "literalFontFamily"]) {
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
      if (counts.rawHex > 0 || counts.literalFontFamily > 0)
        actual[path.relative(root, absolute)] = counts;
    }
  }
  return actual;
}

function main() {
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
  const actual = scanDesignTokenCss();
  const findings = compareBudget(actual, budget);
  if (findings.length > 0) {
    console.error(
      `FAIL — design-token CSS ratchet found ${findings.length} mismatch(es):`
    );
    for (const finding of findings.sort()) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  const totals = Object.values(actual).reduce(
    (sum, counts) => ({
      rawHex: sum.rawHex + counts.rawHex,
      literalFontFamily: sum.literalFontFamily + counts.literalFontFamily,
    }),
    { rawHex: 0, literalFontFamily: 0 }
  );
  console.log(
    `ok   design-token-css — ${totals.rawHex} grandfathered hex value(s), ` +
      `${totals.literalFontFamily} literal font stack(s), zero regressions`
  );
}

if (process.argv[1] === import.meta.filename) main();
