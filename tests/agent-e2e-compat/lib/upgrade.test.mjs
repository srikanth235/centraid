// W5.4 (#842) — unit pins for the install/upgrade lifecycle judge. `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UPGRADE_BLOCKERS,
  assertUpgradePreservedData,
  judgeUpgradeJourney,
  resolvePreviousInstaller,
} from "./upgrade.mjs";

test("resolvePreviousInstaller: no env → #790 blocked-external skip", () => {
  const r = resolvePreviousInstaller({});
  assert.equal(r.available, false);
  assert.equal(r.reason, UPGRADE_BLOCKERS.noInstaller);
  assert.match(r.reason, /#790/u);
});

test("resolvePreviousInstaller: a path resolves to available", () => {
  const r = resolvePreviousInstaller({
    CENTRAID_UPGRADE_PREV_INSTALLER: "/tmp/prev.dmg",
  });
  assert.deepEqual(r, { available: true, installer: "/tmp/prev.dmg" });
});

test("assertUpgradePreservedData: identical snapshot → ok", () => {
  const snap = { "row/1": "aaa", "row/2": "bbb" };
  assert.deepEqual(assertUpgradePreservedData(snap, { ...snap }), { ok: true });
});

test("assertUpgradePreservedData: new rows after upgrade are allowed", () => {
  const before = { "row/1": "aaa" };
  const after = { "row/1": "aaa", "row/2": "new" };
  assert.deepEqual(assertUpgradePreservedData(before, after), { ok: true });
});

test("assertUpgradePreservedData: a dropped row is caught", () => {
  const before = { "row/1": "aaa", "row/2": "bbb" };
  const after = { "row/1": "aaa" };
  assert.deepEqual(assertUpgradePreservedData(before, after), {
    ok: false,
    dropped: ["row/2"],
    mutated: [],
  });
});

test("assertUpgradePreservedData: a mutated row is caught", () => {
  const before = { "row/1": "aaa" };
  const after = { "row/1": "MUTATED" };
  assert.deepEqual(assertUpgradePreservedData(before, after), {
    ok: false,
    dropped: [],
    mutated: ["row/1"],
  });
});

test("assertUpgradePreservedData: accepts Map snapshots", () => {
  const before = new Map([["k", "v"]]);
  const after = new Map([["k", "v"]]);
  assert.deepEqual(assertUpgradePreservedData(before, after), { ok: true });
});

test("judgeUpgradeJourney: not available → #790 skip", () => {
  const v = judgeUpgradeJourney({ available: false });
  assert.equal(v.verdict, "skip");
  assert.match(v.reason, /#790/u);
});

test("judgeUpgradeJourney: available but nothing installed → fail", () => {
  const v = judgeUpgradeJourney({ available: true, installedPrev: false });
  assert.equal(v.verdict, "fail");
  assert.match(v.reason, /vacuous/u);
});

test("judgeUpgradeJourney: data not preserved → fail names dropped/mutated", () => {
  const v = judgeUpgradeJourney({
    available: true,
    installedPrev: true,
    upgraded: true,
    preservation: { ok: false, dropped: ["row/2"], mutated: [] },
  });
  assert.equal(v.verdict, "fail");
  assert.match(v.reason, /row\/2/u);
});

test("judgeUpgradeJourney: preserved but journey failed → fail", () => {
  const v = judgeUpgradeJourney({
    available: true,
    installedPrev: true,
    upgraded: true,
    preservation: { ok: true },
    journalPassed: false,
  });
  assert.equal(v.verdict, "fail");
});

test("judgeUpgradeJourney: full green → pass", () => {
  const v = judgeUpgradeJourney({
    available: true,
    installedPrev: true,
    upgraded: true,
    preservation: { ok: true },
    journalPassed: true,
  });
  assert.equal(v.verdict, "pass");
});
