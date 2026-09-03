#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const BUDGETS = {
  "packages/client/src": 21,
  "packages/blueprints": 4,
  "packages/design/src/elements": 12,
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".app-boot",
]);
const EXTENSION = /\.css$/u;

const INTERACTIVE_PSEUDO_RE =
  /:hover\b|:focus-visible\b|:focus-within\b|:focus\b|:active\b/gu;

function blankComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "));
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTENSION.test(p)) out.push(p);
  }
  return out;
}

function nextBlock(src, from) {
  const openIdx = src.indexOf("{", from);
  if (openIdx === -1) return null;
  let depth = 1;
  let i = openIdx + 1;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null; // unbalanced — bail, don't guess.
  return { selectorStart: from, openIdx, closeIdx: i };
}

function parseLeafRules(src, from, to, inKeyframes, out) {
  let i = from;
  while (i < to) {
    const block = nextBlock(src, i);
    if (!block || block.openIdx >= to) break;
    const selector = src.slice(block.selectorStart, block.openIdx).trim();
    const body = src.slice(block.openIdx + 1, block.closeIdx);
    if (/^@(?:media|supports)\b/u.test(selector)) {
      parseLeafRules(src, block.openIdx + 1, block.closeIdx, inKeyframes, out);
    } else if (/^@keyframes\b/u.test(selector)) {
      parseLeafRules(src, block.openIdx + 1, block.closeIdx, true, out);
    } else if (selector.startsWith("@")) {
      // Intentionally empty.
    } else {
      out.push({
        selector,
        body,
        bodyStart: block.openIdx + 1,
        inKeyframes,
      });
    }
    i = block.closeIdx + 1;
  }
  return out;
}

function splitSelectors(selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isInteractiveSelectorPart(part) {
  return INTERACTIVE_PSEUDO_RE.test(part);
}

function coreKey(part) {
  INTERACTIVE_PSEUDO_RE.lastIndex = 0;
  return part.replace(INTERACTIVE_PSEUDO_RE, "").replace(/\s+/gu, " ").trim();
}

function numericValue(raw) {
  const cleaned = raw.replace(/!important/u, "").trim();
  if (!/^[0-9.]+$/u.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const OPACITY_DECL_RE = /(?<![\w-])opacity\s*:\s*(?<value>[^;}]+)[;}]/gu;

function findOpacityDecls(body) {
  const decls = [];
  let match;
  OPACITY_DECL_RE.lastIndex = 0;
  while ((match = OPACITY_DECL_RE.exec(body))) {
    decls.push({ raw: match.groups.value.trim(), offset: match.index });
  }
  return decls;
}

function hasHoverRevealTo1(rules, key) {
  for (const rule of rules) {
    if (rule.inKeyframes) continue;
    const parts = splitSelectors(rule.selector);
    const hasMatchingInteractivePart = parts.some(
      (p) => isInteractiveSelectorPart(p) && coreKey(p) === key
    );
    if (!hasMatchingInteractivePart) continue;
    for (const decl of findOpacityDecls(rule.body)) {
      if (numericValue(decl.raw) === 1) return true;
    }
  }
  return false;
}

function scanFile(src, rel) {
  const counted = [];
  const classifiedAway = {
    keyframes: 0,
    interactivePseudo: 0,
    disabledToken: 0,
    hoverReveal: 0,
  };

  const rules = parseLeafRules(src, 0, src.length, false, []);

  for (const rule of rules) {
    const decls = findOpacityDecls(rule.body);
    if (decls.length === 0) continue;

    const parts = splitSelectors(rule.selector);
    const ruleIsInteractive = parts.some((p) => isInteractiveSelectorPart(p));

    for (const decl of decls) {
      const line = lineOf(src, rule.bodyStart + decl.offset);

      if (rule.inKeyframes) {
        classifiedAway.keyframes += 1;
        continue;
      }
      if (/^var\(\s*--o-disabled\s*\)$/u.test(decl.raw)) {
        classifiedAway.disabledToken += 1;
        continue;
      }
      if (ruleIsInteractive) {
        classifiedAway.interactivePseudo += 1;
        continue;
      }

      const value = numericValue(decl.raw);
      if (value === null || !(value > 0 && value < 1)) continue; // 0, 1, or non-literal — out of scope.

      const revealed = parts.some((p) => hasHoverRevealTo1(rules, coreKey(p)));
      if (revealed) {
        classifiedAway.hoverReveal += 1;
        continue;
      }

      counted.push(
        `${rel}:${line} — ${rule.selector} { opacity: ${decl.raw} }`
      );
    }
  }

  return { counted, classifiedAway };
}

export function lintContainerOpacity(root = ROOT, budgets = BUDGETS) {
  const perPackage = {};
  for (const pkg of Object.keys(budgets)) {
    perPackage[pkg] = {
      counted: [],
      classifiedAway: {
        keyframes: 0,
        interactivePseudo: 0,
        disabledToken: 0,
        hoverReveal: 0,
      },
      filesScanned: 0,
    };
  }

  for (const pkg of Object.keys(budgets)) {
    const dir = path.resolve(root, pkg);
    if (!existsSync(dir)) {
      perPackage[pkg].missingTarget = pkg;
      continue;
    }
    for (const file of walk(dir)) {
      const rel = path.relative(root, file);
      perPackage[pkg].filesScanned += 1;
      const src = blankComments(readFileSync(file, "utf8"));
      const { counted, classifiedAway } = scanFile(src, rel);
      perPackage[pkg].counted.push(...counted);
      for (const key of Object.keys(classifiedAway)) {
        perPackage[pkg].classifiedAway[key] += classifiedAway[key];
      }
    }
  }

  return perPackage;
}

const TS_EXTENSION = /\.tsx?$/u;
const PRESS_CONTEXT_RE = /press|hover/iu;
const TS_OPACITY_DECL_RE = /(?<![\w-])opacity\s*:\s*(?<value>[^,;}]+)[,;}]/gu;

const TS_BUDGETS = {
  "apps/mobile/src": 0,
};

function blankJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length));
}

function walkExt(dir, extension, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walkExt(p, extension, out);
    else if (extension.test(p)) out.push(p);
  }
  return out;
}

function enclosingBraceOpen(src, idx) {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const c = src[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function findTsOpacityDecls(src) {
  const decls = [];
  let match;
  TS_OPACITY_DECL_RE.lastIndex = 0;
  while ((match = TS_OPACITY_DECL_RE.exec(src))) {
    decls.push({ raw: match.groups.value.trim(), index: match.index });
  }
  return decls;
}

function scanTsFile(src, rel) {
  const counted = [];
  const classifiedAway = { pressOrHover: 0, nonLiteral: 0 };

  for (const decl of findTsOpacityDecls(src)) {
    const value = numericValue(decl.raw);
    if (value === null || !(value > 0 && value < 1)) {
      if (value === null) classifiedAway.nonLiteral += 1;
      continue; // 0, 1, or non-literal (Animated value, expression) — out of scope.
    }

    const openIdx = enclosingBraceOpen(src, decl.index);
    const contextStart = Math.max(0, openIdx - 120);
    const context = openIdx === -1 ? "" : src.slice(contextStart, openIdx);

    if (PRESS_CONTEXT_RE.test(context)) {
      classifiedAway.pressOrHover += 1;
      continue;
    }

    const line = lineOf(src, decl.index);
    const keyMatch = /(?<key>[A-Za-z_$][\w$]*)\s*:\s*$/u.exec(
      context.trimEnd()
    );
    const where = keyMatch
      ? `key "${keyMatch.groups.key}"`
      : context.trim().slice(-40) || "(module scope)";
    counted.push(`${rel}:${line} — ${where} { opacity: ${decl.raw} }`);
  }

  return { counted, classifiedAway };
}

export function lintContainerOpacityMobile(root = ROOT, budgets = TS_BUDGETS) {
  const perPackage = {};
  for (const pkg of Object.keys(budgets)) {
    perPackage[pkg] = {
      counted: [],
      classifiedAway: { pressOrHover: 0, nonLiteral: 0 },
      filesScanned: 0,
    };
  }

  for (const pkg of Object.keys(budgets)) {
    const dir = path.resolve(root, pkg);
    if (!existsSync(dir)) {
      perPackage[pkg].missingTarget = pkg;
      continue;
    }
    for (const file of walkExt(dir, TS_EXTENSION)) {
      const rel = path.relative(root, file);
      perPackage[pkg].filesScanned += 1;
      const src = blankJsComments(readFileSync(file, "utf8"));
      const { counted, classifiedAway } = scanTsFile(src, rel);
      perPackage[pkg].counted.push(...counted);
      perPackage[pkg].classifiedAway.pressOrHover +=
        classifiedAway.pressOrHover;
      perPackage[pkg].classifiedAway.nonLiteral += classifiedAway.nonLiteral;
    }
  }

  return perPackage;
}

function report(perPackage, budgets, { fileKind, awaySummaryOf }) {
  let anyFail = false;
  let anyMissing = false;

  for (const pkg of Object.keys(budgets)) {
    const result = perPackage[pkg];
    if (result.missingTarget) {
      console.error(`FAIL — target does not exist: ${pkg}`);
      anyMissing = true;
      continue;
    }
    if (result.filesScanned === 0) {
      console.error(
        `FAIL — scanned 0 ${fileKind} files under ${pkg}. Targets are stale in scripts/lint-container-opacity.mjs.`
      );
      anyMissing = true;
      continue;
    }

    const budget = budgets[pkg];
    const count = result.counted.length;
    const awaySummary = awaySummaryOf(result.classifiedAway);

    if (count > budget) {
      anyFail = true;
      console.error(
        `\nFAIL — ${pkg}: ${count} container-opacity occurrence(s) exceeds budget of ${budget}:\n`
      );
      for (const f of result.counted.sort()) console.error(`  ${f}`);
      console.error(
        `\nclassified away (not counted): ${awaySummary}\n` +
          "DESIGN.md: state (disabled/inactive/recessive) must never be expressed\n" +
          "by fading a container — use `opacity: var(--o-disabled)` on a leaf, or\n" +
          "`--text-disabled`. Hover-reveal, press feedback, and entrance/exit\n" +
          "animation opacity are not violations; if this occurrence is one of\n" +
          "those and the classifier missed it, see scripts/lint-container-opacity.mjs.\n"
      );
    } else if (count < budget) {
      console.log(
        `ok   ${pkg}: ${count} container-opacity occurrence(s), budget ${budget} ` +
          `(${awaySummary}) — NOTE: budget is ${budget - count} above the measured ` +
          `count; lower the budget for "${pkg}" to ${count} in scripts/lint-container-opacity.mjs.`
      );
    } else {
      console.log(
        `ok   ${pkg}: ${count} container-opacity occurrence(s), at budget ${budget} (${awaySummary})`
      );
    }
  }

  return { anyFail, anyMissing };
}

function main() {
  const cssResult = report(lintContainerOpacity(), BUDGETS, {
    fileKind: ".css",
    awaySummaryOf: (away) =>
      `keyframes=${away.keyframes} interactive-pseudo=${away.interactivePseudo} ` +
      `disabled-token=${away.disabledToken} hover-reveal=${away.hoverReveal}`,
  });
  const tsResult = report(lintContainerOpacityMobile(), TS_BUDGETS, {
    fileKind: ".ts/.tsx",
    awaySummaryOf: (away) =>
      `press-or-hover=${away.pressOrHover} non-literal=${away.nonLiteral}`,
  });

  if (
    cssResult.anyMissing ||
    cssResult.anyFail ||
    tsResult.anyMissing ||
    tsResult.anyFail
  )
    process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
