#!/usr/bin/env node
// aria-label discipline gate (issue #708 section B.4).
//
// Two rules, both source-scanned (no DOM, matching the repo's existing
// regex-based lint scripts — see lint-css-classes.mjs):
//
//   1. `aria-label` may only sit on an ICON-ONLY control — one with no
//      visible text content. An element that already renders visible text
//      and ALSO carries `aria-label` is either redundant (screen readers
//      read the label, sighted users read the text — they can drift) or a
//      sign the label is overriding real content it shouldn't.
//   2. A decorative inline `<svg>` (no `role="img"`, no `aria-label`/`title`
//      of its own) must carry `aria-hidden` — otherwise some screen readers
//      narrate the raw path data or an empty "graphic" as a second,
//      redundant stop next to the control's own accessible name.
//
// Heuristic, not a full parser: JSX open tags are walked char-by-char
// (`tagEnd`) tracking `{…}` expression depth and quote state so a `>` inside
// an inline arrow function (`onClick={() => …}`) doesn't get mistaken for
// the tag's own close — a plain `[^>]*>` regex breaks on exactly that. Once
// the true tag boundaries are known, children up to the balanced closing tag
// are found the same depth-tracked way, `{…}` expression children are
// stripped, and what remains is tested for literal visible text.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const TARGETS = ["packages/client/src/react", "packages/design/kit"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);
const EXTENSIONS = /\.(?:tsx|ts|jsx|js|html)$/u;
// Test files exercise both correct and deliberately-wrong markup as fixtures;
// they are not shipped UI.
const SKIP_FILE = /\.test\.[jt]sx?$/u;

// Dated, shrink-only allowlist (see header on lint-css-classes.mjs for the
// convention this follows). Add an entry only with a comment explaining why
// it is legitimate rather than a bug, and only in a file this gate's owner
// (packages/design) does not also own outright.
// 2026-08-03 — packages/client/src/react/screens/BuilderChatMessages.tsx:77.
// The change-summary card button's visible content is a multi-part layout
// (icon + title + subtitle + version), and its `aria-label` intentionally
// gives a SHORTER, cleaner accessible name ("N files updated — toggle
// details") than reading all four spans literally would produce, appending
// the control's action ("toggle details") that no visible span states. That
// is a legitimate custom accessible name for a rich/composite control, not a
// duplicate-label bug — shrink this list if the card's content is
// simplified enough that the visible text alone can serve as the name.
const ALLOWLIST = new Set([
  "packages/client/src/react/screens/BuilderChatMessages.tsx",
]);

// Rule 1 (aria-label only on icon-only CONTROLS) is scoped to elements that
// are actually controls in the accessibility-tree sense — button, link,
// form field — not every element aria-label can legally sit on. A <dialog>,
// <aside>, <fieldset>, or <form> carrying aria-label is naming a REGION or
// GROUP for the accessibility tree, a distinct and equally valid use of the
// attribute that is allowed to coexist with visible heading/legend text
// (there is no text-node equivalent of a landmark's accessible name — that's
// what aria-label/aria-labelledby are FOR on a region). Scoping down to real
// controls is what makes the "icon-only" half of the rule mean something
// instead of firing on every labelled modal in the app.
// `<select>` is deliberately excluded: its "visible text" is always the
// current option's label, which is structural (every select shows SOME
// text) rather than a duplicate of a separate caption — the same reason
// `<option>` content isn't itself flagged. A `<select>` with no wrapping
// `<label>` legitimately needs `aria-label` for its own name.
const CONTROL_TAGS = new Set(["button", "a", "input", "textarea"]);
const CONTROL_ROLE_RE =
  /\brole\s*=\s*["'](?:button|link|tab|menuitem|checkbox|radio|switch)["']/u;

// A control can legitimately render its icon as a text glyph instead of an
// <svg> (✕, →, ↑, ↓, ★, ⟲, ⓘ, %, ×, −, +…) — that IS the icon, not prose
// alongside it, and pairing it with `aria-label="Close"` etc. is the standard
// accessible pattern. Only content that contains a letter or digit counts as
// "visible text" for rule 1; a short run of symbol/punctuation/pictograph
// characters does not.
function isIconGlyphOnly(text) {
  return !/[\p{L}\p{N}]/u.test(text) && text.length <= 3;
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** WCAG 2.5.3 (Label in Name) only requires the accessible name to CONTAIN
 *  the visible text, not equal it — a card-style button naming itself
 *  "Close quick capture" for visible text "Close" is compliant, not a
 *  redundant duplicate. Only checked when the aria-label is a plain quoted
 *  string; a `{…}` expression value is left to the existing checks. */
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

/**
 * From `start` (index of the `<` in an OPEN tag, not a closing `</` one),
 * find the index of the `>` that actually closes it — skipping `>` that
 * appear inside a `{…}` JS expression or a quoted string in an attribute
 * value. Returns null if the file runs out before a balanced `>` is found.
 */
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

/**
 * Find the index just past the matching `</tagName>` for the element whose
 * open tag closes at `openEnd` (index of its `>`, from `tagEnd`). Tracks
 * same-name nested opens/self-closes so `<div><div>x</div></div>` resolves
 * correctly. Returns null (bail, don't guess) if unbalanced.
 */
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

/** Strip `{ … }` JS/JSX expression children, respecting brace nesting, so a
 *  literal string embedded in an expression (`{"Save"}`) isn't mistaken for
 *  raw JSX text and a raw text node isn't mistaken for markup. */
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

/** Strip `<...>` tags (opening/closing/self-closing) — used after
 *  `stripExpressions` to isolate bare text nodes. */
function stripTags(src) {
  return src.replace(/<[^>]*>/gu, " ");
}

/** Blank out `//` and `/* *\/` comment bodies (keep length/newlines so line
 *  numbers stay accurate) so an example tag mentioned in prose — e.g. this
 *  file's own header, or `agentGlyphs.tsx`'s "without the outer `<svg>`
 *  element" comment — is never mistaken for real markup. */
function blankComments(src) {
  // `(?<!:)` excludes `https://` etc. inside string literals — a real line
  // comment is never preceded by `:`.
  return src.replace(/(?<!:)\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (m) =>
    m.replace(/[^\n]/gu, " ")
  );
}

/** Scan one file's source for `aria-label` placements on elements that also
 *  render visible text. */
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

/** Scan for decorative `<svg>` missing `aria-hidden`. A meaningful svg
 *  (carries its own `role="img"` or `aria-label`) is exempt. */
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
      // Rule 1 (aria-label vs. visible text) is scoped to real JSX/HTML —
      // `.ts`/`.js` files here build markup via string concatenation
      // (`'<button>' + ICON + '</button>'`), where JS operators and
      // identifiers sit inside what looks like an element's children and a
      // tag-matching heuristic cannot tell code from content. Rule 2 (svg
      // aria-hidden) is a same-tag attribute check with no such ambiguity,
      // so it still runs everywhere.
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
