#!/usr/bin/env node
// Rule-weight gate for apps/mobile (#679).
//
// The v4 handoff draws EVERY border and rule as `border: 1px solid <token>`.
// React Native's `StyleSheet.hairlineWidth` is not that: it is one PHYSICAL
// pixel, so on a 3× phone it resolves to 0.33pt — a third of the specified
// edge. Surfaces in this system sit only a few percent off the page by design
// (a tile's `bgElev` is a 3% step off `bg`), which leaves the EDGE doing most
// of the work of separating a plate from the page. At a third strength the
// plate read as missing rather than subtle, which is exactly how the launcher
// tiles, the band, and the Photos chrome all ended up looking washed out on
// device while matching the handoff in a simulator screenshot.
//
// The one rule weight is `borders.hairline` from @centraid/design, re-exported
// directly by apps/mobile/src/kit/theme. The registry carries the value; this
// gate only makes the wrong spelling unrepresentable.
//
// Like the logical-inset gate, this is a source scan rather than a runtime
// test: nothing throws and nothing warns when a border is drawn a third too
// thin — the pixels are simply wrong. Comments and string bodies are blanked
// first, so the token's own prose (and this file's) can name the trap.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_SRC = path.join("apps", "mobile", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo"]);

/** Blank comments and string bodies, preserving offsets so lines still match. */
function blankNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/gu, (m) => m.replace(/[^\n]/gu, " "));
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, out);
    else if (/\.(?:ts|tsx)$/u.test(absolute)) out.push(absolute);
  }
  return out;
}

/** Findings for one file's source text. Exported so the test can drive it. */
export function scanSource(source, label = "<source>") {
  const code = blankNonCode(source);
  const findings = [];
  // The identifier in any form: `StyleSheet.hairlineWidth`, a destructured
  // `hairlineWidth`, or a test mock that re-declares it as a StyleSheet field.
  const identifier = /\bhairlineWidth\b/gu;
  let match = identifier.exec(code);
  while (match !== null) {
    const line = code.slice(0, match.index).split("\n").length;
    findings.push(
      `${label}:${line}: \`hairlineWidth\` — one PHYSICAL pixel is 0.33pt on a ` +
        `3× screen, a third of the handoff's \`border: 1px solid\`; ` +
        `write \`borders.hairline\` (@centraid/design) instead`
    );
    identifier.lastIndex = match.index + 1;
    match = identifier.exec(code);
  }
  return findings;
}

export function scanHairline(root = ROOT) {
  const sourceRoot = path.join(root, MOBILE_SRC);
  const findings = [];
  for (const file of walk(sourceRoot)) {
    findings.push(
      ...scanSource(readFileSync(file, "utf8"), path.relative(root, file))
    );
  }
  return findings;
}

function main() {
  const sourceRoot = path.join(ROOT, MOBILE_SRC);
  if (!existsSync(sourceRoot)) throw new Error(`${MOBILE_SRC} is missing`);
  const findings = scanHairline();
  if (findings.length > 0) {
    console.error("FAIL — mobile rule-weight gate:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok   mobile rule weight — every edge is `borders.hairline`, a full point"
  );
}

if (process.argv[1] === import.meta.filename) main();
