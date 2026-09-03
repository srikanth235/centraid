#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

const BLOB_NAME = /^blob-(?<index>\d+)-(?<total>\d+)\.json$/u;

export function checkShardBlobs(files, expected) {
  const errors = [];
  if (!Number.isInteger(expected) || expected < 1) {
    return [`--expect must be a positive integer, got ${expected}`];
  }
  const seen = new Map();
  for (const file of files) {
    const match = BLOB_NAME.exec(file);
    if (!match) continue;
    const index = Number(match.groups.index);
    const total = Number(match.groups.total);
    if (total !== expected) {
      errors.push(
        `${file} was produced by a ${total}-way split but this lane dispatched ${expected}. ` +
          `The shard count moved in one place and not the other; the merged report would ` +
          `measure a different world than the one that ran.`
      );
      continue;
    }
    if (seen.has(index)) {
      errors.push(
        `shard ${index}/${total} appears more than once — two runners scored the same slice, ` +
          `so some other slice is missing from the merge.`
      );
      continue;
    }
    seen.set(index, file);
  }
  const missing = [];
  for (let index = 1; index <= expected; index += 1) {
    if (!seen.has(index)) missing.push(index);
  }
  if (missing.length) {
    errors.push(
      `missing blob(s) for shard(s) ${missing.join(", ")} of ${expected}. Merging now would score a ` +
        `SMALLER test universe: the coverage floors, the matrix minimumTests floors, ` +
        `test:suite-wall-clock and test:collection-tripwire would all pass against a partial ` +
        `world. Refusing to merge (#556).`
    );
  }
  return errors;
}

function parseArgs(argv) {
  const out = { expect: null, dir: ".vitest-reports" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--expect" && argv[i + 1]) out.expect = Number(argv[++i]);
    else if (argv[i] === "--dir" && argv[i + 1]) out.dir = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(root, args.dir);
  if (!existsSync(dir)) {
    console.error(
      `::error title=No shard blobs::${args.dir} does not exist — every shard's report is missing, so there is nothing to merge.`
    );
    process.exitCode = 1;
    return;
  }
  const errors = checkShardBlobs(readdirSync(dir), args.expect);
  if (errors.length) {
    for (const error of errors) console.error(`::error::shard-blobs: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `shard-blobs: all ${args.expect} shard report(s) present in ${args.dir} — the merged world is whole`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
