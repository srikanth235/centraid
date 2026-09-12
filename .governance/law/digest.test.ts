// @ts-nocheck — RuleTester fixtures are partial arrival records.
// The re-record helper's own tests (#1005).
//
// The property that matters is narrow and total: it rewrites exactly its own
// two rows and passes every other byte of the manifest through untouched. A
// helper that could quietly move the kit's `run.sh` digest would be a way to
// launder a hand edit to the runner.
import assert from "node:assert/strict";
import test from "node:test";

import { RECORDED_PATHS, record } from "./digest.ts";

const manifest = [
  "version: '3'",
  'kit_version: "0.15.0"',
  "managed_digests:",
  "  .github/workflows/governance.yml: aaa",
  "  .governance/lib.sh: bbb",
  "  .governance/run.sh: ccc",
  "collisions: []",
  "",
].join("\n");

test("it inserts its own rows, sorted, and touches no other line", () => {
  const out = record(manifest, Object.fromEntries(RECORDED_PATHS.map((file, i) => [file, `${i}`])));
  const lines = out.split("\n");
  assert.equal(lines[0], "version: '3'");
  assert.equal(lines[1], 'kit_version: "0.15.0"');
  assert.equal(lines[2], "managed_digests:");
  assert.ok(lines.includes("  .github/workflows/governance.yml: aaa"));
  assert.ok(lines.includes("  .governance/lib.sh: bbb"));
  assert.ok(lines.includes("  .governance/run.sh: ccc"));
  assert.ok(lines.includes("  .governance/law/arrival.ts: 0"));
  assert.equal(lines.at(-2), "collisions: []");
  // The block stays sorted, so a re-record never reorders the diff.
  const block = lines.slice(3, lines.indexOf("collisions: []"));
  assert.deepEqual(block, [...block].sort());
});

test("re-recording replaces its own rows rather than duplicating them", () => {
  const all = Object.fromEntries(RECORDED_PATHS.map((file) => [file, "222"]));
  const once = record(manifest, all);
  const twice = record(once, { ...all, ".governance/law/arrival.ts": "999" });
  assert.equal(twice.match(/law\/arrival\.ts/gu).length, 1);
  assert.match(twice, /\.governance\/law\/arrival\.ts: 999/u);
  assert.match(twice, /\.governance\/run\.sh: ccc/u, "the kit's own rows must survive verbatim");
});

test("it owns the generator and every module it is built from", () => {
  // A superset of the two files the ruling named: splitting the generator
  // across files must not move half of it out from under the digest.
  assert.equal(RECORDED_PATHS[0], ".governance/law/arrival.ts");
  for (const file of [
    ".governance/law/lib/digest.ts",
    ".governance/law/lib/git.ts",
    ".governance/law/lib/managed.ts",
    ".governance/law/lib/registries.ts",
    ".governance/law/lib/rule.ts",
  ]) {
    assert.ok(RECORDED_PATHS.includes(file), `${file} is not under the managed digest`);
  }
});

test("a manifest with no managed_digests block is an error, not a silent no-op", () => {
  assert.throws(() => record("version: '3'\n", {}), /no managed_digests/u);
});
