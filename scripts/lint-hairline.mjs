#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_SRC = path.join("apps", "mobile", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo"]);

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

export function scanSource(source, label = "<source>") {
  const code = blankNonCode(source);
  const findings = [];
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
