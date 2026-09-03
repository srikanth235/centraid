#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const TARGETS = ["packages/client/src/react", "packages/design/src/elements"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
const EXTENSIONS = /\.(?:tsx|ts|jsx|js|html)$/u;
const SKIP_FILE = /\.test\.[jt]sx?$/u;

const ALLOWLIST = new Set([
  "packages/client/src/react/screens/BuilderChatMessages.tsx",
]);

const CONTROL_TAGS = new Set(["button", "a", "input", "textarea"]);
const CONTROL_ROLE_RE =
  /\brole\s*=\s*["'](?:button|link|tab|menuitem|checkbox|radio|switch)["']/u;

function isIconGlyphOnly(text) {
  return !/[\p{L}\p{N}]/u.test(text) && text.length <= 3;
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function ariaLabelContainsVisibleText(tagText, visibleText) {
  const literal = tagText.match(/aria-label\s*=\s*["'](?<label>[^"']*)["']/u);
  if (!literal) return false;
  return normalizeWords(literal.groups?.label ?? "").includes(
    normalizeWords(visibleText)
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTENSIONS.test(p) && !SKIP_FILE.test(p)) out.push(p);
  }
  return out;
}

function tagEnd(src, start) {
  let i = start + 1;
  let braceDepth = 0;
  let quote = null;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (braceDepth === 0 && ch === ">") {
      return i;
    }
  }
  return null;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function findMatchingClose(src, tagName, openEnd) {
  let depth = 1;
  let cursor = openEnd + 1;
  const openMarker = `<${tagName}`;
  const closeMarker = `</${tagName}`;
  while (depth > 0) {
    const nextOpenIdx = src.indexOf(openMarker, cursor);
    const nextCloseIdx = src.indexOf(closeMarker, cursor);
    if (nextCloseIdx === -1) return null;
    const isRealOpen =
      nextOpenIdx !== -1 &&
      nextOpenIdx < nextCloseIdx &&
      /[\s/>]/u.test(src[nextOpenIdx + openMarker.length] ?? "");
    if (isRealOpen) {
      const end = tagEnd(src, nextOpenIdx);
      if (end === null) return null;
      const selfClosing = src.slice(nextOpenIdx, end).trimEnd().endsWith("/");
      if (!selfClosing) depth += 1;
      cursor = end + 1;
      continue;
    }
    const closeEnd = src.indexOf(">", nextCloseIdx);
    if (closeEnd === -1) return null;
    depth -= 1;
    cursor = closeEnd + 1;
    if (depth === 0) return cursor;
  }
  return cursor;
}

function stripExpressions(src) {
  let out = "";
  let depth = 0;
  for (const ch of src) {
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function stripTags(src) {
  return src.replace(/<[^>]*>/gu, " ");
}

function blankComments(src) {
  return src.replace(/(?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (m) =>
    m.replace(/[^\n]/gu, " ")
  );
}

function scanAriaLabelTargets(src, rel) {
  const findings = [];
  const openRe = /<(?<tag>[A-Za-z][\w.]*)(?=[\s/>])/gu;
  let match;
  while ((match = openRe.exec(src))) {
    const tag = match.groups?.tag ?? "";
    const start = match.index;
    const end = tagEnd(src, start);
    if (end === null) continue;
    const tagText = src.slice(start, end + 1);
    if (!/\baria-label\s*=/u.test(tagText)) continue;
    const isControl = CONTROL_TAGS.has(tag) || CONTROL_ROLE_RE.test(tagText);
    if (!isControl) continue;
    const line = lineOf(src, start);

    if (tagText.trimEnd().endsWith("/>")) continue; // self-closing: no children possible.

    const closeEnd = findMatchingClose(src, tag, end);
    if (closeEnd === null) continue; // unbalanced — don't guess.
    const closeStart = src.lastIndexOf("<", closeEnd - 1);
    const inner = src.slice(end + 1, closeStart);
    const visibleText = stripTags(stripExpressions(inner)).trim();
    if (
      visibleText.length > 0 &&
      !isIconGlyphOnly(visibleText) &&
      !ariaLabelContainsVisibleText(tagText, visibleText)
    ) {
      findings.push(
        `${rel}:${line} — <${tag}> has aria-label AND visible text ` +
          `(${JSON.stringify(visibleText.slice(0, 40))}); aria-label belongs ` +
          `only on icon-only controls`
      );
    }
    openRe.lastIndex = end + 1;
  }
  return findings;
}

function scanSvgAriaHidden(src, rel) {
  const findings = [];
  const svgRe = /<svg(?=[\s/>])/gu;
  let match;
  while ((match = svgRe.exec(src))) {
    const start = match.index;
    const end = tagEnd(src, start);
    if (end === null) continue;
    const tagText = src.slice(start, end + 1);
    if (
      !/\baria-hidden\b/u.test(tagText) &&
      !/\brole\s*=\s*["']img["']/u.test(tagText) &&
      !/\baria-label\s*=/u.test(tagText)
    ) {
      const line = lineOf(src, start);
      findings.push(
        `${rel}:${line} — decorative <svg> has no aria-hidden (and no ` +
          `role="img"/aria-label making it meaningful instead)`
      );
    }
    svgRe.lastIndex = end + 1;
  }
  return findings;
}

export function lintAriaLabels(root = ROOT, targets = TARGETS) {
  const ariaFindings = [];
  const svgFindings = [];
  let filesScanned = 0;

  for (const target of targets) {
    const dir = path.resolve(root, target);
    if (!existsSync(dir)) {
      return {
        ariaFindings,
        svgFindings,
        filesScanned,
        missingTarget: target,
      };
    }
    for (const file of walk(dir)) {
      const rel = path.relative(root, file);
      if (ALLOWLIST.has(rel)) continue;
      filesScanned += 1;
      const src = blankComments(readFileSync(file, "utf8"));
      if (/\.[tj]sx$/u.test(file) || file.endsWith(".html")) {
        ariaFindings.push(...scanAriaLabelTargets(src, rel));
      }
      svgFindings.push(...scanSvgAriaHidden(src, rel));
    }
  }
  return { ariaFindings, svgFindings, filesScanned, missingTarget: null };
}

function main() {
  const reportOnly = process.argv.includes("--report-only");
  const { ariaFindings, svgFindings, filesScanned, missingTarget } =
    lintAriaLabels();

  if (missingTarget) {
    console.error(`FAIL — target does not exist: ${missingTarget}`);
    process.exit(1);
  }

  if (filesScanned === 0) {
    console.error(
      "FAIL — scanned 0 files. TARGETS or EXTENSIONS are stale in scripts/lint-aria-labels.mjs."
    );
    process.exit(1);
  }

  const findings = [...ariaFindings, ...svgFindings];

  if (findings.length > 0) {
    const label = reportOnly ? "report" : "FAIL";
    console.error(
      `\n${label} — ${findings.length} aria-label discipline violation(s) across ${filesScanned} file(s):\n`
    );
    for (const f of findings.sort()) console.error(`  ${f}`);
    console.error(
      "\naria-label may only sit on an icon-only control (no visible text); a\n" +
        "decorative inline <svg> must carry aria-hidden. See\n" +
        "scripts/lint-aria-labels.mjs for the exact rule and the allowlist.\n"
    );
    if (!reportOnly) process.exit(1);
    return;
  }

  console.log(
    `ok   aria-labels — ${filesScanned} file(s), aria-label only on icon-only controls, decorative svgs marked aria-hidden`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
