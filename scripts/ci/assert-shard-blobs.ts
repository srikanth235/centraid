#!/usr/bin/env node
/**
 * Fail-closed guard for the sharded coverage lane (#892 Phase 1).
 *
 * THE FAILURE THIS EXISTS TO MAKE IMPOSSIBLE. Splitting `bun run coverage`
 * across N runners means the gates downstream — the coverage floors, the matrix
 * `minimumTests` floors, `test:suite-wall-clock`, `test:collection-tripwire` —
 * all score a report assembled from blobs. If a blob is missing (a shard that
 * died, an artifact that failed to upload, a matrix whose size was changed in
 * one place and not the other), the merged report is a SMALLER WORLD and every
 * one of those gates passes more easily. Nothing is red; the suite is simply
 * partly absent. That is #556's shape exactly, and it is the specific risk the
 * split introduces, so it gets its own guard rather than a comment.
 *
 * The check is deliberately about IDENTITY, not count. Vitest names each blob
 * `blob-<index>-<total>.json`, so this can assert the exact set {1..N} of total
 * N — which catches "two runners both ran shard 3" and "the matrix says 8 and
 * the blobs say 6" as different, nameable errors instead of one arithmetic
 * coincidence.
 *
 * Usage: node scripts/ci/assert-shard-blobs.ts --expect 8 [--dir .vitest-reports]
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

const BLOB_NAME = /^blob-(?<index>\d+)-(?<total>\d+)\.json$/u;

/**
 * Compare the blobs on disk against the shard count that was dispatched.
 *
 * @param files directory listing
 * @param expected shard count the lane dispatched
 * @returns human-readable errors; empty means the world is whole
 */
export function checkShardBlobs(files: string[], expected: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(expected) || expected < 1) {
    return [`--expect must be a positive integer, got ${expected}`];
  }
  const seen = new Map<number, string>();
  for (const file of files) {
    const match = BLOB_NAME.exec(file);
    if (!match) continue;
    const groups = match.groups;
    if (!groups) continue;
    const index = Number(groups["index"]);
    const total = Number(groups["total"]);
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
  const missing: number[] = [];
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

function parseArgs(argv: string[]): { expect: number; dir: string } {
  const out = { expect: Number.NaN, dir: ".vitest-reports" };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--expect" && next !== undefined) {
      out.expect = Number(next);
      i += 1;
    } else if (current === "--dir" && next !== undefined) {
      out.dir = next;
      i += 1;
    }
  }
  return out;
}

function main(): void {
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
