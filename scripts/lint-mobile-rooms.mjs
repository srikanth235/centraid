#!/usr/bin/env node
/**
 * THE ROOMS GATE (#1015, Wave 4) — six rules over the mobile screen tree.
 *
 * WHY THIS EXISTS. A nine-lane audit of the Expo app found six headers, seven
 * back affordances, five search placements, five confirm shapes, eight-plus
 * empty states and five date formats across nine surfaces. The kit that would
 * have prevented all of it already existed; what did not exist was anything
 * that noticed a screen ignoring it. So the seven rooms (`kit/rooms/README.md`)
 * are only half the answer, and this is the other half.
 *
 * WIRED, as of Wave 4: `bun run lint:product` runs this with `--enforce`.
 * Waves 2 and 3 migrated the screens; report-only (exit 0) is still the
 * default so the numbers can be read without failing anything, and
 * `--max <n>` remains as a ratchet.
 *
 * WHAT IS A SCREEN, EXACTLY. `screen-root` used to fire on every `.tsx` under
 * the two trees, which counted 153 findings — and most of them were LEAF
 * COMPONENTS. A row, a card, a section block, a header part: none of those is
 * a screen, none of them may be a room, and every one of them was a finding.
 * A rule that cries about a hundred non-problems does not get wired; it gets
 * ignored. So a file is a screen iff the app REGISTERS it as one:
 *
 *   - `apps/mobile/lazy-screens.tsx` names it in a `lazyScreen(() =>
 *     import("./src/…"))` — that file is the composition root's screen
 *     registry, and a `component=` prop on a navigator is the only way any of
 *     those bindings is reachable; or
 *   - it is a `*Screen.tsx` / `*Home.tsx` frame, which is the naming the tree
 *     uses for a cover a navigator mounts.
 *
 * Anything else is a leaf and is not a finding, however it is rooted. The
 * registry is READ, not restated, so a screen added to the app is a screen
 * here the same commit.
 *
 * THE SIX RULES.
 *
 *   screen-root      A screen file's default export returns a root that is not
 *     one of the seven rooms. This is the rule the other four exist to make
 *     unnecessary: a screen inside a room cannot hand-roll a header.
 *     ONE LEVEL OF FRAME (R-NY-7, #1015). An app frame — `LockerScreen`,
 *     `PeopleScreen`, `PhotosScreen`, `TallyScreen` — owns the band, the wall
 *     and the lockup, and its own default export roots in a room. A screen
 *     rooted in such a frame IS a room screen, so the rule resolves the root's
 *     default import (a relative `import X from "./X"`) and passes the screen
 *     when THAT file's root is one of the seven. Exactly one level: a frame
 *     rooted in another frame is a finding, because at two hops the text no
 *     longer proves which room the member stands in. `selfTest` plants both
 *     ways, and the two-hop case.
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
 *   error-detail     `error.message`, `String(err)` or `err.toString()` flowing
 *     into member copy — a room's `error`/`detail`/`secondary`, a `message`,
 *     a `reason`, or the one status channel (`postStatus`/`showUndoStatus`).
 *     S14: the audit found engine vocabulary and raw payloads on six shell
 *     surfaces and in every app's error card — a Swift filename, a
 *     `FetchRequestCanceledException`, a sandbox lane refusal. An exception is
 *     a fact about the PROGRAM. Capturing one for a log is fine and this rule
 *     does not see it; rendering one is the finding.
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
 * HOW `--enforce` ENFORCES, and why it is per-rule. EVERY rule is now at ZERO
 * tree-wide and any new finding fails the gate outright — that is the brief's
 * requirement: a new hand-rolled screen root, back literal, gutter literal,
 * tint on a control or Title Case label is a red diff, not a six-month audit.
 * `screen-root` was the last rule holding a baseline, for `PhotoLightbox`; the
 * seventh room (`StageRoom`, R-NY-14) is the honest room that surface was
 * waiting for, so the baseline file is empty and every rule is unconditional.
 *
 * The per-rule ratchet machinery stays, because a baseline is a RATCHET and
 * may only ever go DOWN: above it fails, BELOW it prints the number to lower
 * it to, and a rule absent from the file is at zero. A baseline is not a
 * licence — each entry names the wave that clears it, and when that wave
 * lands the entry goes to 0 and stays there.
 *
 * Usage:
 *   node scripts/lint-mobile-rooms.mjs             # report-only, exit 0
 *   node scripts/lint-mobile-rooms.mjs --enforce   # per-rule baselines
 *   node scripts/lint-mobile-rooms.mjs --max 40    # one whole-tree ratchet
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
  // The full-bleed media stage (R-NY-14) — the room `PhotoLightbox` stood
  // outside the six for, and the reason `screen-root` now has no baseline.
  "StageRoom",
];

/** Where screens live. `kit/` is the kit's own tree and is exempt by design. */
const SCREEN_DIRS = ["apps/mobile/src/apps", "apps/mobile/src/screens"];

export const RULES = [
  "screen-root",
  "back-literal",
  "page-margin",
  "identity-tint",
  "copy-title-case",
  "error-detail",
];

/** The recorded ratchet, per rule. Read, never written by this script. */
const BASELINE_FILE = "scripts/lint-mobile-rooms.baseline.json";

/**
 * The per-rule ratchet. A rule the file does not name is at ZERO.
 *
 * @param {string} [root] Repo root.
 * @returns {Record<string, number>} Rule → the highest count that passes.
 */
export function readBaseline(root = ROOT) {
  /** @type {Record<string, number>} */
  const floor = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  let raw;
  try {
    raw = readFileSync(path.join(root, BASELINE_FILE), "utf8");
  } catch {
    return floor;
  }
  const parsed = JSON.parse(raw);
  for (const rule of RULES)
    if (typeof parsed.rules?.[rule]?.max === "number")
      floor[rule] = parsed.rules[rule].max;
  return floor;
}

/** The composition root's screen registry; see "WHAT IS A SCREEN" above. */
const SCREEN_REGISTRY = "apps/mobile/lazy-screens.tsx";

/**
 * Every screen module the app registers, as repo-relative `.tsx` paths.
 *
 * Read from the registry rather than restated here, so a screen added to the
 * app is a screen to this rule in the same commit. An unreadable registry
 * answers with an EMPTY set, which the caller turns into a hard failure rather
 * than a quiet pass — the same reason `scanned === 0` is an error.
 *
 * @param {string} [root] Repo root.
 * @returns {Set<string>} Repo-relative paths.
 */
export function registeredScreens(root = ROOT) {
  let source;
  try {
    source = readFileSync(path.join(root, SCREEN_REGISTRY), "utf8");
  } catch {
    return new Set();
  }
  return new Set(
    [...source.matchAll(/import\("\.\/(?<module>src\/[^"]+)"\)/gu)].map(
      (match) => `apps/mobile/${match.groups?.module ?? ""}.tsx`
    )
  );
}

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

/**
 * A file the APP treats as a screen — not merely a `.tsx` that renders.
 *
 * A leaf component (a row, a card, a section) is not a screen, may not be a
 * room, and is not a finding. Two ways in: the registry names the module, or
 * the file is a `*Screen.tsx` / `*Home.tsx` frame.
 *
 * @param {string} relative Repo-relative path.
 * @param {Set<string>} registry Registered screen modules.
 * @returns {boolean} True when the six-rooms rule applies to this file.
 */
export function isScreenFile(relative, registry = new Set()) {
  if (!relative.endsWith(".tsx")) return false;
  if (relative.includes(".test.") || relative.endsWith(".styles.tsx"))
    return false;
  if (registry.has(relative)) return true;
  return /(?:Screen|Home)\.tsx$/u.test(relative);
}

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
 * Where a screen's root tag comes from, when it is a relative default import.
 *
 * `import LockerScreen from "./LockerScreen";` → `apps/…/locker/LockerScreen.tsx`.
 * A named import, a package import or a tag defined in the same file answers
 * `null`: the one level this rule resolves is an app's own frame, and a frame
 * is always the default export of a sibling module.
 *
 * @param {string} relative Repo-relative path of the importing screen.
 * @param {string} source Its text.
 * @param {string} tag The root tag to resolve.
 * @returns {string|null} Repo-relative `.tsx` path, or null.
 */
export function frameModuleOf(relative, source, tag) {
  const escaped = tag.replace(/[.$]/gu, "\\$&");
  const match = new RegExp(
    `import\\s+${escaped}\\s+from\\s+["'](?<spec>\\.{1,2}/[^"']+)["']`,
    "u"
  ).exec(source);
  const spec = match?.groups?.spec;
  if (spec === undefined) return null;
  return `${path.posix.join(path.posix.dirname(relative), spec)}.tsx`;
}

/**
 * True when `tag` is a frame whose OWN root is one of the six rooms — one
 * level, never recursive (see "ONE LEVEL OF FRAME" above).
 *
 * @param {string} relative Repo-relative path of the screen.
 * @param {string} source The screen's text.
 * @param {string} tag The screen's root tag.
 * @param {(relative: string) => string|null} readSource Reads a module.
 * @returns {boolean} True when the frame roots in a room.
 */
function frameIsRoom(relative, source, tag, readSource) {
  const module = frameModuleOf(relative, source, tag);
  if (module === null) return false;
  const frame = readSource(module);
  if (frame === null) return false;
  const frameRoot = rootTagOf(frame);
  return frameRoot !== null && ROOMS.includes(frameRoot);
}

/** Where an exception would become member copy. */
const COPY_SINK =
  /(?:postStatus|showUndoStatus)\s*\(|\b(?:detail|message|reason|secondary|error|body|title|label)\s*:/u;

/** An exception's own words, however they are extracted. */
const RAW_EXCEPTION =
  /\b(?:error|err|e|cause|reason)\.message\b|\bString\((?:error|err|e|cause)\)|\b(?:error|err|e)\.toString\(\)/u;

/**
 * Run the six rules over one file.
 *
 * @param {string} relative Repo-relative path.
 * @param {string} source File text.
 * @param {Set<string>} [registry] Registered screen modules.
 * @param {(relative: string) => string|null} [readSource] Reads a sibling
 *   module by repo-relative path, for the one frame level `screen-root`
 *   resolves; the default reads nothing, so a frame-rooted screen is a finding.
 * @returns {{rule: string, path: string, detail: string}[]} Findings.
 */
export function lintFile(
  relative,
  source,
  registry = new Set(),
  readSource = () => null
) {
  const findings = [];
  const add = (rule, detail) => findings.push({ detail, path: relative, rule });

  // S14 (#1015). Line-scoped: the sink and the extraction have to be the same
  // expression, so `catch (error) { log(error.message) }` beside an unrelated
  // `message:` two lines away is not a finding.
  for (const line of source.split("\n"))
    if (COPY_SINK.test(line) && RAW_EXCEPTION.test(line))
      add("error-detail", line.trim().slice(0, 90));

  if (isScreenFile(relative, registry)) {
    const root = rootTagOf(source);
    if (
      root !== null &&
      !ROOMS.includes(root) &&
      !frameIsRoom(relative, source, root, readSource)
    )
      add("screen-root", `root is <${root}>, not one of the seven rooms`);
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
  const registry = registeredScreens(root);
  const readSource = (relative) => {
    try {
      return readFileSync(path.join(root, relative), "utf8");
    } catch {
      return null;
    }
  };
  const findings = [];
  for (const file of files) {
    if (!/\.tsx?$/u.test(file) || file.includes(".test.")) continue;
    const relative = path.relative(root, file);
    findings.push(
      ...lintFile(relative, readFileSync(file, "utf8"), registry, readSource)
    );
  }
  return { findings, registry, scanned: files.length };
}

/** Rule counts, every rule present even at zero. */
export function countByRule(findings) {
  const counts = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  for (const finding of findings) counts[finding.rule] += 1;
  return counts;
}

/** The rules, proven against fixtures before the tree is touched. */
export function selfTest() {
  const HAND_ROLLED =
    "export default function A() {\n return (\n <SafeAreaView>x</SafeAreaView>);}";
  const cases = [
    ["screen-root", "apps/mobile/src/apps/x/AScreen.tsx", HAND_ROLLED],
    ["back-literal", "b.tsx", '<DocsShelfHeader backTo="All" />'],
    ["page-margin", "apps/mobile/src/apps/x/c.tsx", "paddingHorizontal: 18,"],
    ["identity-tint", "d.tsx", '<Button label="x" color={appIdentity} />'],
    ["copy-title-case", "view-copy.ts", 'export const A = "Empty Trash";'],
    [
      "error-detail",
      "f.tsx",
      "postStatus(error instanceof Error ? error.message : String(error));",
    ],
    ["error-detail", "g.tsx", "setState({ message: err.message });"],
  ];
  for (const [rule, file, source] of cases) {
    const hit = lintFile(file, source).some((finding) => finding.rule === rule);
    if (!hit) throw new Error(`lint-mobile-rooms: rule ${rule} does not fire`);
  }

  // A LEAF IS NOT A SCREEN. This is the whole point of the predicate: the
  // same hand-rolled root in a row component is not a finding.
  const leaf = lintFile("apps/mobile/src/apps/x/RowCard.tsx", HAND_ROLLED);
  if (leaf.some((finding) => finding.rule === "screen-root"))
    throw new Error("lint-mobile-rooms: a leaf component is a screen-root");

  // …and the registry is the other way in, for a screen named anything.
  const registered = lintFile(
    "apps/mobile/src/apps/x/Lightbox.tsx",
    HAND_ROLLED,
    new Set(["apps/mobile/src/apps/x/Lightbox.tsx"])
  );
  if (!registered.some((finding) => finding.rule === "screen-root"))
    throw new Error("lint-mobile-rooms: the registry does not name a screen");

  // ONE LEVEL OF FRAME (R-NY-7), both ways and the hop beyond. A screen rooted
  // in its app's frame passes when the frame roots in a room, fails when the
  // frame hand-rolls its root, and fails when the frame is itself a frame.
  const frameScreen =
    'import AppFrame from "./AppFrame";\nexport default function S() {\n return (\n <AppFrame>x</AppFrame>);}';
  const frames = {
    "apps/mobile/src/apps/x/AppFrame.tsx":
      "export default function F() {\n return (\n <PushedPage>x</PushedPage>);}",
    "apps/mobile/src/apps/y/AppFrame.tsx":
      "export default function F() {\n return (\n <View>x</View>);}",
    "apps/mobile/src/apps/z/AppFrame.tsx":
      'import Inner from "./Inner";\nexport default function F() {\n return (\n <Inner>x</Inner>);}',
    "apps/mobile/src/apps/z/Inner.tsx":
      "export default function I() {\n return (\n <AppPlace>x</AppPlace>);}",
  };
  const readFrame = (relative) => frames[relative] ?? null;
  const rootedIn = (app) =>
    lintFile(
      `apps/mobile/src/apps/${app}/SScreen.tsx`,
      frameScreen,
      new Set(),
      readFrame
    ).some((finding) => finding.rule === "screen-root");
  if (rootedIn("x"))
    throw new Error("lint-mobile-rooms: a frame rooted in a room is a finding");
  if (!rootedIn("y"))
    throw new Error("lint-mobile-rooms: a frame rooted in <View> passes");
  if (!rootedIn("z"))
    throw new Error("lint-mobile-rooms: a frame resolves more than one level");

  // Capturing an exception for a log is not rendering it.
  const captured = lintFile(
    "h.ts",
    "catch (error) {\n  console.warn(error.message);\n}"
  );
  if (captured.length > 0)
    throw new Error("lint-mobile-rooms: a captured exception is a finding");

  for (const room of ROOMS) {
    const clean = lintFile(
      "apps/mobile/src/apps/x/EScreen.tsx",
      `export default function E() {\n return (\n <${room}>x</${room}>);}`
    );
    if (clean.length > 0)
      throw new Error(`lint-mobile-rooms: <${room}> is a finding`);
  }

  if (registeredScreens().size === 0)
    throw new Error("lint-mobile-rooms: the screen registry read as empty");
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
  if (enforce) {
    const baseline = readBaseline();
    let failed = false;
    for (const rule of RULES) {
      const at = counts[rule];
      const ceiling = baseline[rule];
      if (at > ceiling) {
        failed = true;
        console.error(
          ceiling === 0
            ? `fail lint-mobile-rooms — ${rule}: ${at} finding(s), and this rule is at zero`
            : `fail lint-mobile-rooms — ${rule}: ${at} above the recorded ${ceiling}`
        );
        for (const finding of findings.filter((f) => f.rule === rule))
          console.error(`  ${finding.path}: ${finding.detail}`);
      } else if (at < ceiling)
        console.log(
          `  NOTE ${rule} is ${at}, under its recorded ${ceiling} — lower it in ${BASELINE_FILE}`
        );
    }
    if (failed) return 1;
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
