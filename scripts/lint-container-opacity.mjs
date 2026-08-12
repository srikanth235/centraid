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
  "packages/design/kit": 12,
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

/**
 * Find the index of the `{` that opens the next top-level block starting
 * at-or-after `from`, and the index of its matching `}` (simple depth
 * counting — CSS doesn't nest braces inside string/url values in any of
 * these files, matching the brace-counting approach lint-css-classes.mjs
 * and the other structural CSS gates use).
 */
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

/**
 * Parse `src` into leaf rules: `{ selector, body, bodyStart, inKeyframes }`.
 * Recurses into `@media`/`@supports` (structural — keeps scanning their
 * contents as top-level rules) and `@keyframes` (marks every declaration
 * inside as `inKeyframes`, since its nested blocks are keyframe selectors
 * like `from`/`to`/`50%`, not element selectors).
 */
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

function splitSelectors(selector) {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isInteractiveSelectorPart(part) {
  return INTERACTIVE_PSEUDO_RE.test(part);
}

/** Selector with interactive pseudo-classes stripped, for hover-reveal
 *  pairing: `.railItem:hover` and `.railItem` share this core. */
function coreKey(part) {
  INTERACTIVE_PSEUDO_RE.lastIndex = 0;
  return part.replace(INTERACTIVE_PSEUDO_RE, "").replace(/\s+/gu, " ").trim();
}

/** Parse an `opacity:` declaration value to a finite number, or null if it
 *  isn't a bare literal (e.g. `var(...)`, `calc(...)`). */
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

/** Does any rule in `rules` have an interactive selector part sharing
 *  `key`'s core and set `opacity: 1` (bare) in its body? */
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

/** Scan one file, returning classified findings. */
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

// ── Mobile (React Native) — TS/TSX object-literal scan (issue #708 §B/gate
// blind spot) ─────────────────────────────────────────────────────────────
//
// The CSS scan above is a brace-walk over CSS *rules*: it classifies a
// declaration away by looking at the rule's *selector* (does it carry
// `:hover`/`:active`, is it inside `@keyframes`, …). React Native
// `StyleSheet.create({...})` objects have no selectors — the mobile
// equivalent of "this state is momentary, not resting" is a `Pressable`
// render-prop (`({ pressed }) => …`) or a style key named for that
// interaction, not a CSS pseudo-class. So this scan classifies a declaration
// away by looking at what immediately *introduces* its enclosing object
// literal instead of what selects it:
//
//   1. Press/hover feedback — the key name (`tabPressed:`) or guard
//      (`pressed && { … }`, `pressed ? { … } : …`) text immediately before
//      the enclosing `{` contains "press" or "hover". HomeBand.tsx's
//      `tabPressed: { opacity: 0.6 }` is the canonical legitimate case this
//      must NOT count.
//   2. Non-literal values (`opacity: fade`, `opacity: anim.interpolate(…)`)
//      — an Animated/Reanimated value driving entrance/exit or gesture
//      opacity, never a hardcoded state flag. Same treatment as the CSS
//      side's `var(...)`/boundary exclusion: only a bare numeric literal
//      strictly between 0 and 1 is examined at all, so these fall out
//      automatically rather than needing their own rule.
//
// Everything else — including a hardcoded disabled/dim/recede fade on a key
// that isn't press-guarded — counts against the budget below, unclassified,
// exactly like the CSS side's philosophy: this scan does not adjudicate
// whether a given container fade is "legitimate" beyond those two
// mechanical cases, it ratchets.
const TS_EXTENSION = /\.tsx?$/u;
const PRESS_CONTEXT_RE = /press|hover/iu;
const TS_OPACITY_DECL_RE = /(?<![\w-])opacity\s*:\s*(?<value>[^,;}]+)[,;}]/gu;

// 2026-08-03 — measured via `node scripts/lint-container-opacity.mjs` after
// closing the AllAppsSheet.tsx container-opacity BLOCKER (issue #708). The
// scan surfaced pre-existing, out-of-territory hardcoded disabled/dim
// fades this pass does not touch — Button.tsx `disabled` (0.45),
// apps/locker/LockerHome.styles.ts `disabled` (0.5),
// apps/automations/Automations.styles.ts `dim` (0.55), and
// apps/photos/PhotosHome.tsx `heroEyebrow` (0.9) — each a genuine container-
// or leaf-opacity state fade by the same rule, just not one this change
// owns. The budget records that debt rather than hiding it; it only shrinks
// from here.
const TS_BUDGETS = {
  // 2026-08-03: the four pre-existing fades this scanner first surfaced
  // (kit Button, Locker's unlock primary, Automations' in-flight controls,
  // Photos' hero eyebrow) are gone — each now recedes through leaf colour
  // tokens. Native starts clean, so it starts at zero and stays there.
  "apps/mobile/src": 0,
};

function blankJsComments(src) {
  // Line + block comments only — string/template contents are irrelevant
  // here, since `opacity:` never appears meaningfully inside one of these
  // files' string literals.
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

/** Backward brace-match: the index of the `{` that opens the object literal
 *  enclosing `idx`, by walking left and balancing braces. Mirrors the
 *  forward `nextBlock` walk above, just run in the other direction since we
 *  start from a declaration and want its container, not a selector and its
 *  body. */
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

/** Scan one .ts/.tsx file, returning classified findings (mirrors CSS
 *  `scanFile`'s shape). */
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

/** Shared pass/fail report for one (perPackage, budgets, kind) triple —
 *  used for both the CSS scan and the mobile TS/TSX scan so the two stay
 *  visually and behaviourally identical at the CLI. */
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
