import assert from "node:assert/strict";
import test from "node:test";

import { checkShardBlobs } from "./assert-shard-blobs.mjs";

const blobs = (n) =>
  Array.from({ length: n }, (_, i) => `blob-${i + 1}-${n}.json`);

test("a complete set of blobs passes", () => {
  assert.deepEqual(checkShardBlobs(blobs(8), 8), []);
});

test("a missing shard is refused and named", () => {
  const files = blobs(8).filter((f) => f !== "blob-5-8.json");
  const errors = checkShardBlobs(files, 8);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /shard\(s\) 5 of 8/u);
  assert.match(errors[0], /SMALLER test universe/u);
});

test("a shard-count mismatch is a different, nameable error", () => {
  // The blobs say 6-way, the lane dispatched 8-way: the matrix and the shard
  // argument drifted apart. Merging would score a world nobody chose.
  const errors = checkShardBlobs(blobs(6), 8);
  assert.ok(
    errors.some((e) => /6-way split but this lane dispatched 8/u.test(e))
  );
});

test("a duplicated shard is caught even when the count happens to match", () => {
  const files = [
    "blob-1-3.json",
    "blob-2-3.json",
    "blob-2-3.json",
    "blob-3-3.json",
  ];
  // Same file name twice cannot happen on one disk, so exercise the real
  // shape: a directory listing that repeats an index.
  const errors = checkShardBlobs(files, 3);
  assert.ok(errors.some((e) => /appears more than once/u.test(e)));
});

test("an empty directory is refused rather than merging nothing", () => {
  const errors = checkShardBlobs([], 4);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /shard\(s\) 1, 2, 3, 4 of 4/u);
});

test("unrelated files in the directory are ignored", () => {
  assert.deepEqual(
    checkShardBlobs([...blobs(2), "README.md", ".DS_Store"], 2),
    []
  );
});

test("a nonsensical --expect fails rather than passing vacuously", () => {
  assert.match(checkShardBlobs(blobs(4), 0)[0], /positive integer/u);
  assert.match(checkShardBlobs(blobs(4), Number.NaN)[0], /positive integer/u);
});
