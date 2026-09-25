#!/usr/bin/env node
// The 11px type floor (issue #708 §"One type ramp") — a source-scan gate,
// not a budget. `packages/design/src/eleven-px-floor.test.ts` proves the
// RAMP itself (`toCss()` / `toNativeTheme()`) never drops below 11px, but it
// has no visibility into a hardcoded literal a consumer stylesheet writes on
// its own — `.deviceListCurrent { font-size: 9.5px }` shipped straight past
// that test the same day the ramp landed. This gate closes that hole by
// scanning the CONSUMERS directly: hardcoded CSS `font-size` (px or rem) in
// the CSS surface that draws from the ramp.
//
// Zero tolerance, not a ratchet budget (contrast lint-container-opacity.mjs):
// the 11px floor is DESIGN.md's own invariant ("Nothing falls below 11px" —
// packages/design/src/typography.ts's header), not a migration surface with
// legitimate pre-existing debt to shrink over time. Every violation this
// gate finds gets fixed in the same change that adds the gate.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const FLOOR = 11;
const REM_BASE_PX = 16;

const CSS_TARGETS = ["packages/design/src/elements"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
const CSS_EXTENSION = /\.css$/u;

function walk(dir, extension, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, extension, out);
    else if (extension.test(p)) out.push(p);
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** Blank `/* … *\/` comment bodies to spaces, preserving newlines/length
 *  so line numbers stay accurate and a size mentioned in prose is never
 *  mistaken for a real declaration. */
function blankCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "));
}

// ── CSS: hardcoded `font-size` below the floor ──────────────────────────────
//
// Only a bare numeric literal (`px` or `rem`) counts — `var(--t-*-size)`,
// `calc(...)`, `clamp(...)`, and keyword values (`inherit`/`unset`/`initial`)
// are either already routed through the ramp or aren't a text size at all,
// and `0` is the empty/reset value, not a shrunk text size.
const CSS_FONT_SIZE_RE =
  /(?<![\w-])font-size\s*:\s*(?<value>[0-9.]+)(?<unit>px|rem)\s*[;}]/gu;

function scanCssFile(src, rel) {
  const findings = [];
  CSS_FONT_SIZE_RE.lastIndex = 0;
  let match;
  while ((match = CSS_FONT_SIZE_RE.exec(src))) {
    const raw = Number(match.groups.value);
    const unit = match.groups.unit;
    const px = unit === "rem" ? raw * REM_BASE_PX : raw;
    if (px === 0) continue;
    if (px < FLOOR) {
      const line = lineOf(src, match.index);
      findings.push(
        `${rel}:${line} — font-size: ${raw}${unit} (${px}px, floor is ${FLOOR}px)`
      );
    }
  }
  return findings;
}

export function lintTypeFloorCss(root = ROOT, targets = CSS_TARGETS) {
  const findings = [];
  let filesScanned = 0;
  for (const target of targets) {
    const dir = path.resolve(root, target);
    if (!existsSync(dir))
      return { findings, filesScanned, missingTarget: target };
    for (const file of walk(dir, CSS_EXTENSION)) {
      const rel = path.relative(root, file);
      filesScanned += 1;
      const src = blankCssComments(readFileSync(file, "utf8"));
      findings.push(...scanCssFile(src, rel));
    }
  }
  return { findings, filesScanned, missingTarget: null };
}

function main() {
  const reportOnly = process.argv.includes("--report-only");

  const css = lintTypeFloorCss();

  if (css.missingTarget) {
    console.error(`FAIL — target does not exist: ${css.missingTarget}`);
    process.exit(1);
  }
  if (css.filesScanned === 0) {
    console.error(
      "FAIL — scanned 0 .css files. CSS_TARGETS is stale in scripts/lint-type-floor.mjs."
    );
    process.exit(1);
  }

  const { findings } = css;

  if (findings.length > 0) {
    const label = reportOnly ? "report" : "FAIL";
    console.error(
      `\n${label} — ${findings.length} sub-11px type-floor violation(s) across ` +
        `${css.filesScanned} CSS file(s):\n`
    );
    for (const f of findings.sort()) console.error(`  ${f}`);
    console.error(
      "\nNothing falls below 11px (packages/design/src/typography.ts). Tokenize a\n" +
        "hit to the nearest rung ≥11px (usually `var(--t-control-size)`). Never\n" +
        "invent a new size. See scripts/lint-type-floor.mjs.\n"
    );
    if (!reportOnly) process.exit(1);
    return;
  }

  console.log(
    `ok   type-floor — ${css.filesScanned} CSS file(s), nothing below 11px`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
