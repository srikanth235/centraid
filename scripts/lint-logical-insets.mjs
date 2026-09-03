#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_SRC = path.join("apps", "mobile", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo"]);

const LOGICAL_INSET_FIXES = Object.freeze({
  start: "insetInlineStart",
  end: "insetInlineEnd",
});

function blankNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/gu, (m) => m.replace(/[^\n]/gu, " "));
}

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
