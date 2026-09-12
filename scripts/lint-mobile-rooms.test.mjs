// The half `selfTest()` cannot cover (#1015, Wave 4).
//
// `lint-mobile-rooms.mjs` proves its five rules against inline fixtures before
// it reads the tree, which proves the RULES work. It cannot prove the READER
// does: a walker that quietly returns nothing, or a root-tag reader that
// answers `null` for every real screen, makes every rule vacuous and the
// linter reports green on a tree it never looked at. So these run against the
// REAL committed sources.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ROOMS,
  RULES,
  countByRule,
  frameModuleOf,
  isTitleCase,
  lintFile,
  lintTree,
  readBaseline,
  registeredScreens,
  rootTagOf,
  selfTest,
} from "./lint-mobile-rooms.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

/** A committed module by repo-relative path, or null. */
const readSource = (relative) => {
  try {
    return readFileSync(path.join(REPO, relative), "utf8");
  } catch {
    return null;
  }
};

test("every rule fires on its own fixture", () => {
  selfTest();
});

test("the seven rooms are the seven rooms", () => {
  assert.deepEqual([...ROOMS].sort(), [
    "AppPlace",
    "EditorRoom",
    "HomeRoom",
    "PushedPage",
    "SheetRoom",
    "StageRoom",
    "SystemPlace",
  ]);
});

test("the rooms gate and the rooms barrel name the same rooms", () => {
  // The list here is a RESTATEMENT, and a restatement drifts. `StageRoom`
  // (R-NY-14) is the room that proves it: a seventh room the barrel exports
  // and this file did not know about would make `PhotoLightbox` a finding
  // forever, which is exactly how it came to sit in a baseline.
  const barrel = readSource("apps/mobile/src/kit/rooms/index.ts") ?? "";
  const exported = [
    ...barrel.matchAll(/export \{ default as (?<room>\w+) \}/gu),
  ].map((match) => match.groups.room);
  assert.ok(exported.length > 0, "the rooms barrel read as empty");
  assert.deepEqual([...exported].sort(), [...ROOMS].sort());
});

test("the root-tag reader reads the shape screens are actually written in", () => {
  const source = [
    "export default function Thing(): React.JSX.Element {",
    "  const x = 1;",
    "  return (",
    '    <PushedPage title="x">',
    "      <View />",
    "    </PushedPage>",
    "  );",
    "}",
  ].join("\n");
  assert.equal(rootTagOf(source), "PushedPage");
  assert.equal(rootTagOf("export function helper() { return 1; }"), null);
});

test("a room root is not a finding, and a hand-rolled one is", () => {
  const room =
    "export default function A() {\n return (\n <AppPlace>x</AppPlace>);}";
  assert.deepEqual(lintFile("apps/mobile/src/apps/x/AScreen.tsx", room), []);
  const rolled =
    "export default function A() {\n return (\n <SafeAreaView>x</SafeAreaView>);}";
  assert.equal(
    lintFile("apps/mobile/src/apps/x/AScreen.tsx", rolled)[0].rule,
    "screen-root"
  );
  // A LEAF IS NOT A SCREEN (#1015, Wave 4). The same hand-rolled root in a
  // row component was one of 153 findings, ~96 of which were leaves; a rule
  // that cries that often does not get wired, it gets ignored.
  assert.deepEqual(lintFile("apps/mobile/src/apps/x/Row.tsx", rolled), []);
});

test("a screen rooted in its app's frame is resolved one level, on the real tree", () => {
  // R-NY-7 (#1015). Proven against a committed screen and its committed
  // frame, both ways: without the reader the frame is opaque and the screen
  // is a finding; with it, the frame's own room is seen and it is not.
  const relative = "apps/mobile/src/apps/locker/LockerTrashScreen.tsx";
  const source = readSource(relative) ?? "";
  assert.equal(rootTagOf(source), "LockerScreen");
  assert.equal(
    frameModuleOf(relative, source, "LockerScreen"),
    "apps/mobile/src/apps/locker/LockerScreen.tsx"
  );
  const rooted = (reader) =>
    lintFile(relative, source, new Set(), reader).filter(
      (finding) => finding.rule === "screen-root"
    ).length;
  assert.equal(rooted(undefined), 1);
  assert.equal(rooted(readSource), 0);
});

test("the screen registry names real, existing modules", () => {
  // The predicate is only honest if it READS the composition root. An empty
  // or unreadable registry would silently turn every registered screen into a
  // leaf and make `screen-root` vacuous.
  const registry = registeredScreens();
  assert.ok(registry.size > 40, `registry read ${registry.size} screens`);
  for (const relative of registry)
    assert.ok(
      existsSync(path.join(REPO, relative)),
      `registry names a missing module: ${relative}`
    );
});

test("every rule is unconditional — the baseline records nothing", () => {
  // R-NY-14 took `screen-root` to zero and LEFT the baseline, like
  // `page-margin` before it. A baseline may only ever go DOWN, so a rule
  // reappearing here is the ratchet running backwards.
  const baseline = readBaseline();
  for (const rule of RULES)
    assert.equal(
      baseline[rule],
      0,
      `${rule} carries a baseline of ${baseline[rule]}`
    );
  assert.deepEqual(Object.keys(baseline).sort(), [...RULES].sort());
  const { findings } = lintTree();
  const counts = countByRule(findings);
  for (const rule of RULES)
    assert.ok(
      counts[rule] <= baseline[rule],
      `${rule} is ${counts[rule]}, above its recorded ${baseline[rule]}`
    );
});

test("an exception rendered as copy is a finding; one that is logged is not", () => {
  assert.equal(
    lintFile("x.ts", "postStatus('failed: ' + error.message);")[0].rule,
    "error-detail"
  );
  assert.equal(
    lintFile("x.ts", "setState({ detail: String(err) });")[0].rule,
    "error-detail"
  );
  assert.deepEqual(lintFile("x.ts", "console.warn(error.message);"), []);
});

test("the kit's own gutters are exempt, a screen's are not", () => {
  const source = "paddingHorizontal: 18,";
  assert.deepEqual(
    lintFile("apps/mobile/src/kit/components/X.styles.ts", source),
    []
  );
  assert.equal(
    lintFile("apps/mobile/src/screens/X.styles.ts", source)[0].rule,
    "page-margin"
  );
});

test("Title Case is a label, never prose", () => {
  assert.equal(isTitleCase("Empty Trash"), true);
  assert.equal(isTitleCase("Free up vault"), false);
  assert.equal(isTitleCase("Delete"), false);
  assert.equal(isTitleCase("Nothing is waiting on you."), false);
});

test("the tree walk reads real screens rather than nothing", () => {
  const { scanned } = lintTree();
  assert.ok(scanned > 300, `scanned only ${scanned} files`);
  // NOT a population of findings. That used to be the proof — `screen-root`
  // and `page-margin` still saw theirs — and R-NY-6/R-NY-7 (#1015) took both
  // to zero, which a dead reader would ALSO report. What a dead reader cannot
  // fake is reading real roots: nearly every registered screen answers a tag,
  // and the four app frames answer a room.
  const read = [...registeredScreens()].filter(
    (relative) => rootTagOf(readSource(relative) ?? "") !== null
  );
  assert.ok(read.length > 40, `the root reader read ${read.length} screens`);
  for (const frame of [
    "locker/LockerScreen",
    "people/PeopleScreen",
    "photos/PhotosScreen",
    "tally/TallyScreen",
  ]) {
    const root = rootTagOf(
      readSource(`apps/mobile/src/apps/${frame}.tsx`) ?? ""
    );
    assert.ok(ROOMS.includes(root ?? ""), `${frame} roots in <${root}>`);
  }
});
