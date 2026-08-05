#!/usr/bin/env node
// Logical-inset gate for apps/mobile (#679).
//
// React Native's `StyleSheetTypes.d.ts` still DECLARES the legacy logical
// position insets `start` and `end`, so `tsc` and oxlint both wave them
// through — but they are the deprecated spelling and the New Architecture no
// longer reliably lowers them onto the Yoga node. A `position: "absolute"`
// style written with `start: 0, end: 0` therefore type-checks, lint-passes,
// and ships with NO horizontal constraint at all: the view sizes to its
// content and anchors at its static position. That is exactly how the Photos
// band ran off the right edge of the screen and clipped "More", and how the
// custody strip stopped overlaying its tile.
//
// The supported spellings are `insetInlineStart` / `insetInlineEnd`, which the
// renderer applies with precedence over the physical `left` / `right`
// (ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp,
// `applyAliasedProps`). Only the POSITION pair is affected — `marginStart`,
// `paddingEnd`, `borderStartWidth` and friends are still parsed and applied,
// so this gate deliberately does NOT touch them.
//
// The check is a source scan rather than a runtime test because the failure is
// invisible at runtime: nothing throws, nothing warns, the layout is simply
// wrong. It flags `start:` / `end:` used as a key anywhere inside a
// `StyleSheet.create({ ... })` literal — not just in the same object as
// `position: "absolute"`, because positioned styles are routinely composed
// from a base (`styles.pager`) and a side (`styles.pagerPrev`).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_SRC = path.join("apps", "mobile", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo"]);

/** The dead pair, and what to write instead. */
const LOGICAL_INSET_FIXES = Object.freeze({
  start: "insetInlineStart",
  end: "insetInlineEnd",
});

/** Blank comments and string bodies, preserving offsets so lines still match. */
function blankNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/gu, (m) => m.replace(/[^\n]/gu, " "));
}

/**
 * Byte ranges of every `StyleSheet.create({ ... })` argument in `code`
 * (comment- and string-blanked, so braces inside those cannot mislead us).
 */
function styleSheetRanges(code) {
  const ranges = [];
  const opener = /StyleSheet\s*\.\s*create\s*\(/gu;
  let match = opener.exec(code);
  while (match !== null) {
    let depth = 0;
    let index = match.index + match[0].length;
    let started = false;
    while (index < code.length) {
      const ch = code[index];
      if (ch === "{" || ch === "(" || ch === "[") {
        depth += 1;
        started = true;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        depth -= 1;
        if (started && depth <= 0) break;
      }
      index += 1;
    }
    ranges.push([match.index, index]);
    opener.lastIndex = index;
    match = opener.exec(code);
  }
  return ranges;
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
  const ranges = styleSheetRanges(code);
  if (ranges.length === 0) return [];

  const findings = [];
  const key = /(?<before>^|[{,;\n])\s*(?<name>start|end)\s*:/gu;
  let match = key.exec(code);
  while (match !== null) {
    const name = match.groups.name;
    const at = match.index + match[0].indexOf(name);
    if (ranges.some(([from, to]) => at > from && at < to)) {
      const line = code.slice(0, at).split("\n").length;
      findings.push(
        `${label}:${line}: \`${name}:\` inside StyleSheet.create — ` +
          `React Native types it but no longer applies it; ` +
          `write \`${LOGICAL_INSET_FIXES[name]}:\` instead`
      );
    }
    key.lastIndex = at + 1;
    match = key.exec(code);
  }
  return findings;
}

export function scanLogicalInsets(root = ROOT) {
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
  const findings = scanLogicalInsets();
  if (findings.length > 0) {
    console.error("FAIL — mobile logical-inset gate:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok   mobile logical insets — no legacy `start`/`end` position props"
  );
}

if (process.argv[1] === import.meta.filename) main();
