#!/usr/bin/env node
/**
 * THE ROOMS GATE (#1015, Wave 4) — five rules over the mobile screen tree.
 *
 * WHY THIS EXISTS. A nine-lane audit of the Expo app found six headers, seven
 * back affordances, five search placements, five confirm shapes, eight-plus
 * empty states and five date formats across nine surfaces. The kit that would
 * have prevented all of it already existed; what did not exist was anything
 * that noticed a screen ignoring it. So the six rooms (`kit/rooms/README.md`)
 * are only half the answer, and this is the other half.
 *
 * NOT WIRED YET, ON PURPOSE. Wave 2 migrates the screens; wiring this into
 * `check:push` before that would make every gate red on work that has not
 * happened. It runs REPORT-ONLY (exit 0) and prints the count per rule, which
 * is the baseline Wave 3 burns down. `--enforce` is what Wave 4 turns on, and
 * `--max <n>` is the ratchet in between.
 *
 * THE FIVE RULES.
 *
 *   screen-root      A screen file's default export returns a root that is not
 *     one of the six rooms. This is the rule the other four exist to make
 *     unnecessary: a screen inside a room cannot hand-roll a header.
 *   back-literal     `backTo="…"` or `current="…"` written as a string. Audit
 *     B7: thirteen Docs screens said `backTo="All"`, twelve of them wrong, and
 *     the label and the VoiceOver word were wrong together. Inside a room the
 *     prop is a `PlaceRef` and a literal cannot typecheck; this catches the
 *     screens that have not moved yet, and any `as` cast around the brand.
 *   page-margin      `paddingHorizontal: <number>` outside `kit/`. The audit
 *     counted 144, disagreeing by up to 6pt between a header and the list
 *     under it in the same screen. `theme.pageMargin` is the one gutter.
 *   identity-tint    An app's identity hue on a `Button` or `Tappable`. The
 *     hue is the mark chip and a content marker; a tinted control makes every
 *     app's primary a different colour, which is the one thing the type and
 *     colour contract does not allow.
 *   copy-title-case  Two or more capitalised words in a label inside a copy
 *     table. Sentence case is the house rule (D2, superseding #712).
 *
 * WHAT THIS CANNOT SEE, said plainly: it matches text, not a render tree. It
 * proves a file's shape, not that the screen mounts, and a screen that renders
 * its root through a helper reads as unknown rather than as a finding. The
 * mounted claim belongs to the room tests and to the mobile gallery.
 *
 * A SILENT NO-OP IS A FAILURE: zero screen files scanned is an error, not a
 * pass — the same rule `lint-app-conformance.mjs` and `lint-path-filters.mjs`
 * hold themselves to.
 *
 * Usage:
 *   node scripts/lint-mobile-rooms.mjs             # report-only, exit 0
 *   node scripts/lint-mobile-rooms.mjs --enforce   # exit 1 on any finding
 *   node scripts/lint-mobile-rooms.mjs --max 40    # exit 1 above a ratchet
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The only permitted screen roots (`apps/mobile/src/kit/rooms/index.ts`). */
export const ROOMS = [
  "HomeRoom",
  "AppPlace",
  "PushedPage",
  "EditorRoom",
  "SheetRoom",
  "SystemPlace",
];

/** Where screens live. `kit/` is the kit's own tree and is exempt by design. */
const SCREEN_DIRS = ["apps/mobile/src/apps", "apps/mobile/src/screens"];

const RULES = [
  "screen-root",
  "back-literal",
  "page-margin",
  "identity-tint",
  "copy-title-case",
];

/**
 * Every file under `dir`, recursively.
 *
 * @param {string} dir Absolute directory.
 * @returns {string[]} Absolute file paths.
 */
export function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** A file that renders a screen, as opposed to a model, a style sheet or a test. */
const isScreenFile = (relative) =>
  relative.endsWith(".tsx") &&
  !relative.includes(".test.") &&
  !relative.endsWith(".styles.tsx");

/**
 * The JSX tag a default-exported component returns first.
 *
 * Text, not a parser: the shape this looks for is the one every screen in this
 * tree is written in — `export default function X(...): React.JSX.Element {`
 * followed by a `return (` and a tag. Anything else answers `null`, which is
 * "unknown", not "wrong".
 *
 * @param {string} source File text.
 * @returns {string|null} The root tag name, or null when it cannot be read.
 */
export function rootTagOf(source) {
  const at = source.search(/export default (?:function|const)\s/u);
  if (at < 0) return null;
  const body = source.slice(at);
  const match = /return\s*\(?\s*<(?<tag>[A-Za-z][\w.]*)/u.exec(body);
  return match?.groups?.tag ?? null;
}

/**
 * Run the five rules over one file.
 *
 * @param {string} relative Repo-relative path.
 * @param {string} source File text.
 * @returns {{rule: string, path: string, detail: string}[]} Findings.
 */
export function lintFile(relative, source) {
  const findings = [];
  const add = (rule, detail) => findings.push({ detail, path: relative, rule });

  if (isScreenFile(relative)) {
    const root = rootTagOf(source);
    if (root !== null && !ROOMS.includes(root))
      add("screen-root", `root is <${root}>, not one of the six rooms`);
  }

  for (const match of source.matchAll(
    /\b(?<prop>backTo|current)=["'][^"']*["']/gu
  ))
    add("back-literal", match[0]);

  if (!relative.startsWith("apps/mobile/src/kit/"))
    for (const match of source.matchAll(/paddingHorizontal:\s*\d+/gu))
      add("page-margin", match[0]);

  // The control and the tint have to be on the same JSX element, so the match
  // is scoped to one tag rather than to the file.
  for (const tag of source.matchAll(/<(?<control>Button|Tappable)\b[^>]*>/gu))
    if (/appIdentity|--app-identity|identityHue/u.test(tag[0]))
      add(
        "identity-tint",
        `${tag.groups?.control ?? "control"} carries an identity hue`
      );

  if (/copy/iu.test(path.basename(relative)) && relative.endsWith(".ts"))
    for (const match of source.matchAll(
      /["'`](?<label>[^"'`\n]{3,60})["'`]/gu
    )) {
      const label = match.groups?.label ?? "";
      if (isTitleCase(label)) add("copy-title-case", label);
    }

  return findings;
}

/**
 * Two or more capitalised words in a row, none of which is an acronym or a
 * sentence's own first word followed by a proper noun. The heuristic is
 * deliberately narrow: it reads a LABEL ("Empty Trash"), not prose.
 *
 * @param {string} label Candidate text.
 * @returns {boolean} True when it reads as Title Case.
 */
export function isTitleCase(label) {
  const words = label.trim().split(/\s+/u);
  if (words.length < 2 || words.length > 5) return false;
  if (/[.?!,;:]/u.test(label)) return false;
  const capitalised = words.filter((word) => /^[A-Z][a-z]+$/u.test(word));
  return capitalised.length === words.length;
}

/**
 * Lint the whole tree.
 *
 * @param {string} [root] Repo root.
 * @returns {{findings: {rule: string, path: string, detail: string}[], scanned: number}} The run.
 */
export function lintTree(root = ROOT) {
  const files = SCREEN_DIRS.flatMap((dir) => walk(path.join(root, dir)));
  const findings = [];
  for (const file of files) {
    if (!/\.tsx?$/u.test(file) || file.includes(".test.")) continue;
    const relative = path.relative(root, file);
    findings.push(...lintFile(relative, readFileSync(file, "utf8")));
  }
  return { findings, scanned: files.length };
}

/** Rule counts, every rule present even at zero. */
export function countByRule(findings) {
  const counts = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  for (const finding of findings) counts[finding.rule] += 1;
  return counts;
}

/** The rules, proven against fixtures before the tree is touched. */
export function selfTest() {
  const cases = [
    [
      "screen-root",
      "a.tsx",
      "export default function A() {\n return (\n <SafeAreaView>x</SafeAreaView>);}",
    ],
    ["back-literal", "b.tsx", '<DocsShelfHeader backTo="All" />'],
    ["page-margin", "apps/mobile/src/apps/x/c.tsx", "paddingHorizontal: 18,"],
    ["identity-tint", "d.tsx", '<Button label="x" color={appIdentity} />'],
    ["copy-title-case", "view-copy.ts", 'export const A = "Empty Trash";'],
  ];
  for (const [rule, file, source] of cases) {
    const hit = lintFile(file, source).some((finding) => finding.rule === rule);
    if (!hit) throw new Error(`lint-mobile-rooms: rule ${rule} does not fire`);
  }
  const clean = lintFile(
    "apps/mobile/src/apps/x/e.tsx",
    "export default function E() {\n return (\n <AppPlace>x</AppPlace>);}"
  );
  if (clean.length > 0)
    throw new Error("lint-mobile-rooms: a room root is a finding");
}

function main(argv) {
  selfTest();
  const enforce = argv.includes("--enforce");
  const maxAt = argv.indexOf("--max");
  const max = maxAt >= 0 ? Number(argv[maxAt + 1]) : null;
  const { findings, scanned } = lintTree();
  if (scanned === 0) {
    console.error("fail lint-mobile-rooms — no screen files scanned");
    return 1;
  }
  const counts = countByRule(findings);
  for (const rule of RULES) console.log(`  ${rule.padEnd(16)} ${counts[rule]}`);
  console.log(
    `${enforce || max !== null ? "" : "report-only "}lint-mobile-rooms — ${findings.length} finding(s) over ${scanned} file(s)`
  );
  if (enforce && findings.length > 0) {
    for (const finding of findings)
      console.error(`  ${finding.rule}  ${finding.path}: ${finding.detail}`);
    return 1;
  }
  if (max !== null && findings.length > max) {
    console.error(
      `fail lint-mobile-rooms — ${findings.length} above the ratchet ${max}`
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] === import.meta.filename)
  process.exit(main(process.argv.slice(2)));
