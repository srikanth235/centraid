// The half `selfTest()` cannot cover (#1015, Wave 4).
//
// `lint-mobile-rooms.mjs` proves its five rules against inline fixtures before
// it reads the tree, which proves the RULES work. It cannot prove the READER
// does: a walker that quietly returns nothing, or a root-tag reader that
// answers `null` for every real screen, makes every rule vacuous and the
// linter reports green on a tree it never looked at. So these run against the
// REAL committed sources.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ROOMS,
  RULES,
  countByRule,
  isTitleCase,
  lintFile,
  lintTree,
  readBaseline,
  registeredScreens,
  rootTagOf,
  selfTest,
} from "./lint-mobile-rooms.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

test("every rule fires on its own fixture", () => {
  selfTest();
});

test("the six rooms are the six rooms", () => {
  assert.deepEqual([...ROOMS].sort(), [
    "AppPlace",
    "EditorRoom",
    "HomeRoom",
    "PushedPage",
    "SheetRoom",
    "SystemPlace",
  ]);
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

test("the recorded baseline only ever names rules that exist", () => {
  const baseline = readBaseline();
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
  const { findings, scanned } = lintTree();
  assert.ok(scanned > 300, `scanned only ${scanned} files`);
  const counts = countByRule(findings);
  // Not an assertion about the CURRENT numbers — those are the Wave 3 baseline
  // and move every week. What is asserted is that the two rules with a known
  // population still see it, which is what a dead reader would break.
  assert.ok(counts["screen-root"] > 0);
  assert.ok(counts["page-margin"] > 0);
});
