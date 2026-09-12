#!/usr/bin/env node
// Re-record the law generator's own digests in `.governance/install.yaml`
// (#1005).
//
// The generator is under the managed-tree digest, because a rule that reads a
// record is only as trustworthy as the thing that wrote it: a silent edit to
// `arrival.ts` could make every rule downstream say whatever the editor
// wanted. So `install.yaml` records these two files, and changing one without
// re-recording it is refused at the commit hook.
//
// This helper is a convenience, NOT the boundary. Nothing stops an agent from
// running it, or from editing `install.yaml` by hand — every file here is
// agent-writable. The boundary is that `install.yaml` is owned in
// `.github/CODEOWNERS` and a change to it needs the owner's review; the digest
// makes such a change *visible* in the diff rather than preventing it.
//
// Usage:
//   node .governance/law/digest.ts            # report: recorded vs actual
//   node .governance/law/digest.ts --record   # rewrite those two rows
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sha256File } from "./lib/digest.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANIFEST = path.join(ROOT, ".governance/install.yaml");

/**
 * The files this helper owns. Every other row in the manifest is the kit's.
 *
 * The generator is `arrival.ts` plus every module under `lib/` it is built
 * from — a superset of the two files #1005 named, because splitting the
 * generator across files must not be a way to move half of it out from under
 * the digest.
 */
export const RECORDED_PATHS = Object.freeze([
  ".governance/law/arrival.ts",
  ...readdirSync(path.join(import.meta.dirname, "lib"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()
    .map((name) => `.governance/law/lib/${name}`),
]);

/**
 * Rewrite (or insert) exactly this helper's rows in a manifest.
 *
 * Every other line is passed through byte for byte — including the kit's own
 * `run.sh`, `lib.sh` and `governance.yml` rows, which this must never touch.
 *
 * @param {string} manifest The manifest text.
 * @param {Record<string, string>} digests path → digest.
 * @returns {string} The rewritten manifest.
 */
export function record(manifest: string, digests: Record<string, string>) {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => /^managed_digests:\s*$/u.test(line));
  if (start === -1) throw new Error("install.yaml has no managed_digests: block");
  let end = start + 1;
  while (end < lines.length && /^ {2}\S/u.test(lines[end])) end += 1;
  const block = lines
    .slice(start + 1, end)
    .filter((line) => !/^ {2}\.governance\/law\//u.test(line));
  for (const file of RECORDED_PATHS) block.push(`  ${file}: ${digests[file]}`);
  block.sort();
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join("\n");
}

/**
 * The CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} The exit code.
 */
export function main(argv: string[]) {
  const digests = Object.fromEntries(
    RECORDED_PATHS.map((file) => [file, sha256File(path.join(ROOT, file))])
  );
  const manifest = readFileSync(MANIFEST, "utf8");
  if (argv.includes("--record")) {
    writeFileSync(MANIFEST, record(manifest, digests));
    for (const file of RECORDED_PATHS) process.stdout.write(`recorded ${file} ${digests[file]}\n`);
    return 0;
  }
  let drift = 0;
  for (const file of RECORDED_PATHS) {
    const recorded = new RegExp(`^ {2}${file.replaceAll(".", "\\.")}: (?<digest>\\S+)`, "mu").exec(
      manifest
    )?.groups.digest;
    const same = recorded === digests[file];
    if (!same) drift += 1;
    process.stdout.write(`${same ? "✓" : "✗"} ${file} recorded=${recorded ?? "(none)"} actual=${digests[file]}\n`);
  }
  return drift === 0 ? 0 : 1;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
