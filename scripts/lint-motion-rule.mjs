#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const TARGETS = ["packages/client/src", "packages/design/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
const EXTENSIONS = /\.(?:css|ts|tsx)$/u;
const SKIP_FILE = /\.test\.[jt]sx?$/u;

const SANCTIONED = new Set([
  "packages/design/src/css.ts",
  "packages/design/src/blueprint.ts",
  "packages/client/src/react/screens/atlasOrreryMotion.ts",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTENSIONS.test(p) && !SKIP_FILE.test(p)) out.push(p);
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function blankComments(src, isCss) {
  const blockBlanked = src.replace(/\/\*[\s\S]*?\*\//gu, (m) =>
    m.replace(/[^\n]/gu, " ")
  );
  if (isCss) return blockBlanked;
  return blockBlanked.replace(/(?<!:)\/\/[^\n]*/gu, (m) =>
    " ".repeat(m.length)
  );
}

export function lintMotionRule(root = ROOT, targets = TARGETS) {
  const findings = [];
  let filesScanned = 0;

  for (const target of targets) {
    const dir = path.resolve(root, target);
    if (!existsSync(dir))
      return { findings, filesScanned, missingTarget: target };
    for (const file of walk(dir)) {
      const rel = path.relative(root, file);
      if (SANCTIONED.has(rel)) continue;
      filesScanned += 1;
      const isCss = file.endsWith(".css");
      const src = blankComments(readFileSync(file, "utf8"), isCss);
      const re = /prefers-reduced-motion/gu;
      let match;
      while ((match = re.exec(src))) {
        const line = lineOf(src, match.index);
        findings.push(`${rel}:${line} — restates \`prefers-reduced-motion\``);
      }
    }
  }
  return { findings, filesScanned, missingTarget: null };
}

function main() {
  const reportOnly = process.argv.includes("--report-only");
  const { findings, filesScanned, missingTarget } = lintMotionRule();

  if (missingTarget) {
    console.error(`FAIL — target does not exist: ${missingTarget}`);
    process.exit(1);
  }
  if (filesScanned === 0) {
    console.error(
      "FAIL — scanned 0 files. TARGETS is stale in scripts/lint-motion-rule.mjs."
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    const label = reportOnly ? "report" : "FAIL";
    console.error(
      `\n${label} — ${findings.length} \`prefers-reduced-motion\` restatement(s) ` +
        `outside the sanctioned sources across ${filesScanned} file(s):\n`
    );
    for (const f of findings.sort()) console.error(`  ${f}`);
    console.error(
      "\n`prefers-reduced-motion` is honoured in ONE global rule (the design\n" +
        "package's toCss()/blueprint sheet), not per component. Delete the\n" +
        "restatement — the global rule already zeroes animation/transition\n" +
        "duration everywhere — or, if it carries something the global rule does\n" +
        "not reproduce (a hardcoded delay, an opacity/transform override), fix\n" +
        "the root cause so the global rule covers it instead. See\n" +
        "scripts/lint-motion-rule.mjs for the sanctioned-source allowlist.\n"
    );
    if (!reportOnly) process.exit(1);
    return;
  }

  console.log(
    `ok   motion-rule — ${filesScanned} file(s), prefers-reduced-motion honoured in one place`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
