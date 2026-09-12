#!/usr/bin/env node
// Container-opacity budget gate (issue #708 section B).
//
// DESIGN.md's rule: state (disabled/inactive/recessive) must never be
// expressed by fading a CONTAINER. `--o-disabled` on a leaf and
// `--text-disabled` are the sanctioned forms for that state. Hover-reveal
// visibility, momentary press feedback, and entrance/exit animation opacity
// are NOT violations of that rule — they express something other than
// state-fade.
//
// This gate does not (cannot, syntactically) detect every legitimate use.
// It classifies away the mechanical cases a regex/brace-walk CAN tell apart
// with confidence, and treats everything else as counting against a
// per-package BUDGET that only shrinks over time — a ratchet, not a
// judgment call at commit time. See TESTING.md for the ratchet convention
// this follows (test:ratchet, lint-css-classes.mjs's ALLOWLIST).
//
// Classified away (not counted):
//   1. Declarations inside `@keyframes` blocks — the property is being
//      animated through, not used to express a resting state.
//   2. Declarations whose rule's selector carries `:hover`, `:focus`,
//      `:focus-visible`, `:focus-within`, or `:active` — momentary
//      press/hover feedback, not a state fade.
//   3. `opacity: var(--o-disabled)` — the sanctioned disabled-leaf token.
//   4. Hover-reveal pairs: a base (non-interactive) rule sets a fractional
//      opacity, and another rule in the same file whose selector is the
//      same "core" selector PLUS an interactive pseudo-class sets
//      `opacity: 1` — the base value is the rest state of a reveal-on-hover
//      pattern, not a state fade.
//
// Only `opacity:` (not `stroke-opacity` / `fill-opacity` — different CSS
// properties, SVG paint alpha, not DOM container fade) with a literal
// numeric value strictly between 0 and 1 counts. `opacity: 0` and
// `opacity: 1` are boundary values (fully hidden / fully shown — the
// vocabulary of entrance/exit and hover-reveal, not partial dimming) and
// are out of scope for this gate by design (see the task brief this gate
// was commissioned under, issue #708 section B).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

import {
  lintContainerOpacityMobile,
  TS_BUDGETS,
} from "./lint-container-opacity-mobile.ts";
import type { MobilePackageScan } from "./lint-container-opacity-mobile.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

// Per-package budgets — dated, shrink-only.
//
// This number only moves DOWN. If your change removes a counted occurrence,
// lower the budget for that package to match the new count. If your change
// would RAISE a budget, that means you added a new container-opacity state
// fade — don't just bump the number, either fix it (leaf `--o-disabled`
// token / `--text-disabled`) or, if you believe it is a legitimate case this
// gate's classifier can't see, open a DESIGN.md argument for why and land
// the exception with that reasoning attached (see the "Everything else
// counts against the budget" note above — this gate does not adjudicate,
// it ratchets).
//
// 2026-08-03 — measured via `node scripts/lint-container-opacity.mjs`.
// 2026-08-04 — client 25 → 21: the onboarding migration retired the glow blob,
// the pulsing avatar ring and the faded "working" line, all of which expressed
// something (depth, liveness, quiet) by dimming a container.
// 2026-08-04 — blueprints 6 → 5: the docs "+ New" chevron's resting 0.85 fade
// went with the hand-rolled button it decorated; the kit primary carries one
// ink for the whole control.
// 2026-08-11 — blueprints 5 → 4: #738 removed the duplicate app-owned pending
// layers and their faded presentation branches; #739 concurrently added the
// Places graticule leaf. Generated app-boot mirrors are excluded above so this
// source budget remains stable under concurrent gates.
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
  // The blueprint boot harness mirrors source CSS here while check:push runs
  // gates concurrently. Counting both the source and its generated mirror
  // makes the shrink-only budget depend on scheduling rather than source.
  ".app-boot",
]);
const EXTENSION = /\.css$/u;

const INTERACTIVE_PSEUDO_RE =
  /:hover\b|:focus-visible\b|:focus-within\b|:focus\b|:active\b/gu;

/** Blank `/* … *\/` comments to spaces (preserving newlines/length so line
 *  numbers stay accurate), matching the convention in lint-aria-labels.mjs. */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "));
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTENSION.test(p)) out.push(p);
  }
  return out;
}

/**
 * Find the index of the `{` that opens the next top-level block starting
 * at-or-after `from`, and the index of its matching `}` (simple depth
 * counting — CSS doesn't nest braces inside string/url values in any of
 * these files, matching the brace-counting approach lint-css-classes.mjs
 * and the other structural CSS gates use).
 */
function nextBlock(src: string, from: number) {
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

/**
 * Parse `src` into leaf rules: `{ selector, body, bodyStart, inKeyframes }`.
 * Recurses into `@media`/`@supports` (structural — keeps scanning their
 * contents as top-level rules) and `@keyframes` (marks every declaration
 * inside as `inKeyframes`, since its nested blocks are keyframe selectors
 * like `from`/`to`/`50%`, not element selectors).
 */
type CssLeafRule = {
  selector: string;
  body: string;
  bodyStart: number;
  inKeyframes: boolean;
};

function parseLeafRules(
  src: string,
  from: number,
  to: number,
  inKeyframes: boolean,
  out: CssLeafRule[]
): CssLeafRule[] {
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
      // @font-face, @property, @page, … — leaf-like, no nested selectors,
      // opacity here (if any) is not container state — skip entirely.
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

function splitSelectors(selector: string) {
  return selector
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
}

function isInteractiveSelectorPart(part: string) {
  return INTERACTIVE_PSEUDO_RE.test(part);
}

/** Selector with interactive pseudo-classes stripped, for hover-reveal
 *  pairing: `.railItem:hover` and `.railItem` share this core. */
function coreKey(part: string) {
  INTERACTIVE_PSEUDO_RE.lastIndex = 0;
  return part.replace(INTERACTIVE_PSEUDO_RE, "").replace(/\s+/gu, " ").trim();
}

/** Parse an `opacity:` declaration value to a finite number, or null if it
 *  isn't a bare literal (e.g. `var(...)`, `calc(...)`). */
function numericValue(raw: string) {
  const cleaned = raw.replace(/!important/u, "").trim();
  if (!/^[0-9.]+$/u.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const OPACITY_DECL_RE = /(?<![\w-])opacity\s*:\s*(?<value>[^;}]+)[;}]/gu;

function findOpacityDecls(
  body: string
): Array<{ raw: string; offset: number }> {
  const decls: Array<{ raw: string; offset: number }> = [];
  let match: RegExpExecArray | null;
  OPACITY_DECL_RE.lastIndex = 0;
  while ((match = OPACITY_DECL_RE.exec(body))) {
    const raw = match.groups?.value?.trim();
    if (raw === undefined) continue;
    decls.push({ raw, offset: match.index });
  }
  return decls;
}

/** Does any rule in `rules` have an interactive selector part sharing
 *  `key`'s core and set `opacity: 1` (bare) in its body? */
function hasHoverRevealTo1(rules: CssLeafRule[], key: string): boolean {
  for (const rule of rules) {
    if (rule.inKeyframes) continue;
    const parts = splitSelectors(rule.selector);
    const hasMatchingInteractivePart = parts.some(
      (p: string) => isInteractiveSelectorPart(p) && coreKey(p) === key
    );
    if (!hasMatchingInteractivePart) continue;
    for (const decl of findOpacityDecls(rule.body)) {
      if (numericValue(decl.raw) === 1) return true;
    }
  }
  return false;
}

/** Scan one file, returning classified findings. */
function scanFile(
  src: string,
  rel: string
): {
  counted: string[];
  classifiedAway: {
    keyframes: number;
    interactivePseudo: number;
    disabledToken: number;
    hoverReveal: number;
  };
} {
  const counted: string[] = [];
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
    const ruleIsInteractive = parts.some((p: string) =>
      isInteractiveSelectorPart(p)
    );

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

      const revealed = parts.some((p: string) =>
        hasHoverRevealTo1(rules, coreKey(p))
      );
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

type PackageScan = {
  counted: string[];
  classifiedAway: {
    keyframes: number;
    interactivePseudo: number;
    disabledToken: number;
    hoverReveal: number;
  };
  filesScanned: number;
  missingTarget?: string;
};

export function lintContainerOpacity(
  root = ROOT,
  budgets: Record<string, number> = BUDGETS
): Record<string, PackageScan> {
  const perPackage: Record<string, PackageScan> = {};
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
    const scan = perPackage[pkg];
    if (scan === undefined) continue;
    const dir = path.resolve(root, pkg);
    if (!existsSync(dir)) {
      scan.missingTarget = pkg;
      continue;
    }
    for (const file of walk(dir)) {
      const rel = path.relative(root, file);
      scan.filesScanned += 1;
      const src = blankComments(readFileSync(file, "utf8"));
      const { counted, classifiedAway } = scanFile(src, rel);
      scan.counted.push(...counted);
      scan.classifiedAway.keyframes += classifiedAway.keyframes;
      scan.classifiedAway.interactivePseudo += classifiedAway.interactivePseudo;
      scan.classifiedAway.disabledToken += classifiedAway.disabledToken;
      scan.classifiedAway.hoverReveal += classifiedAway.hoverReveal;
    }
  }

  return perPackage;
}

export {
  lintContainerOpacityMobile,
  TS_BUDGETS,
} from "./lint-container-opacity-mobile.ts";

// Mobile (React Native) TS/TSX object-literal scan lives in
// lint-container-opacity-mobile.ts (#1018 split). The CSS scan above is a
// brace-walk over CSS *rules*: it classifies a declaration away by looking at
// the rule's *selector*. React Native StyleSheet objects have no selectors —
// the equivalent of "this state is momentary" is a Pressable render-prop or a
// style key named for that interaction. See the sibling file for that walk.

function report(
  perPackage: Record<string, PackageScan | MobilePackageScan>,
  budgets: Record<string, number>,
  {
    fileKind,
    awaySummaryOf,
  }: {
    fileKind: string;
    awaySummaryOf: (
      away: PackageScan["classifiedAway"] | MobilePackageScan["classifiedAway"]
    ) => string;
  }
): { anyFail: boolean; anyMissing: boolean } {
  let anyFail = false;
  let anyMissing = false;

  for (const pkg of Object.keys(budgets)) {
    const result = perPackage[pkg];
    if (result === undefined) continue;
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

    const budget = budgets[pkg] ?? 0;
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
    awaySummaryOf: (away) => {
      if (!("keyframes" in away)) return "";
      return (
        `keyframes=${away.keyframes} interactive-pseudo=${away.interactivePseudo} ` +
        `disabled-token=${away.disabledToken} hover-reveal=${away.hoverReveal}`
      );
    },
  });
  const tsResult = report(lintContainerOpacityMobile(), TS_BUDGETS, {
    fileKind: ".ts/.tsx",
    awaySummaryOf: (away) => {
      if (!("pressOrHover" in away)) return "";
      return `press-or-hover=${away.pressOrHover} non-literal=${away.nonLiteral}`;
    },
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
