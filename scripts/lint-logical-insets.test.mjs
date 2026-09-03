import assert from "node:assert/strict";
import test from "node:test";

import { scanLogicalInsets, scanSource } from "./lint-logical-insets.mjs";

test("mobile source uses no legacy `start`/`end` position insets", () => {
  assert.deepEqual(scanLogicalInsets(), []);
});

test("the gate catches the legacy pair inside StyleSheet.create", () => {
  const findings = scanSource(
    `const styles = StyleSheet.create({
       band: { bottom: 0, end: 0, position: "absolute", start: 0 },
     });`,
    "fixture.ts"
  );
  assert.equal(findings.length, 2);
  assert.match(findings[0], /fixture\.ts:2: `end:`/u);
  assert.match(findings[0], /insetInlineEnd/u);
  assert.match(findings[1], /fixture\.ts:2: `start:`/u);
  assert.match(findings[1], /insetInlineStart/u);
});

test("the gate ignores `start`/`end` that are not style keys", () => {
  assert.deepEqual(
    scanSource(
      `interface Range { start: string; end: string }
       const service = { start: () => {}, end: () => {} };
       const styles = StyleSheet.create({ row: { flexDirection: "row" } });`,
      "fixture.ts"
    ),
    []
  );
});

test("the gate leaves the surviving margin/padding/border logical props alone", () => {
  assert.deepEqual(
    scanSource(
      `const styles = StyleSheet.create({
         copy: { borderStartWidth: 1, marginStart: 8, paddingEnd: 4 },
       });`,
      "fixture.ts"
    ),
    []
  );
});
