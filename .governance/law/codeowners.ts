#!/usr/bin/env node
// `.github/CODEOWNERS`, DERIVED from the law estate — never hand-written
// (#1005).
//
// The rules under `.governance/law/` observe; they cannot enforce, because
// every file here is agent-writable and nothing an agent can edit is the
// authority for what an agent may do. The enforcement is the host's, and the
// host reads exactly one file to decide who must review a change to the law:
// this one. Generating it from the same `lawPaths` the rules are compiled from
// closes the gap where a new law path is added to a pack and quietly owned by
// nobody.
//
// What the host enforces (branch protection: "require review from Code
// Owners", plus the required `governance` check on the default branch) is
// OWNER-ENABLED, configured outside this repository, and NOT CONFIRMED
// ENABLED. This generator does not turn it on and cannot check that it is on;
// it only guarantees that when it is on, the law estate is what it covers.
//
// Usage:
//   node .governance/law/codeowners.ts           # print the generated file
//   node .governance/law/codeowners.ts --write   # write it
//   node .governance/law/codeowners.ts --check   # exit 1 on drift
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readPacks } from "./eslint.config.ts";
import { byteCompare } from "./lib/digest.ts";
import type { PackDeclaration } from "./lib/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Where the generated file lives. */
export const CODEOWNERS_PATH = ".github/CODEOWNERS";

/** The reviewer every law path answers to. */
export const OWNER = "@srikanth235";

/**
 * The law estate's globs, from every pack, sorted and de-duplicated.
 *
 * @param {object[]} [packs] The packs; defaults to those on disk.
 * @returns {string[]} The globs.
 */
export function lawPaths(packs?: PackDeclaration[]) {
  return normalize((packs ?? readPacks()).flatMap((pack) => pack.lawPaths));
}

/**
 * De-duplicate and order a glob list. One place, so a hand-passed list and the
 * packs' union cannot render differently.
 *
 * @param {string[]} globs The globs.
 * @returns {string[]} Sorted, unique.
 */
function normalize(globs: string[]) {
  return [...new Set(globs)].sort(byteCompare);
}

/**
 * Render the file.
 *
 * @param {string[]} [paths] The law globs; defaults to the packs' union.
 * @returns {string} The file's contents, with a trailing newline.
 */
export function render(paths?: string[]) {
  const globs = paths ? normalize(paths) : lawPaths();
  return [
    "# GENERATED — do not edit by hand.",
    "#",
    "# Written by `node .governance/law/codeowners.ts --write` from the union of",
    "# `lawPaths` in `.governance/law/packs/*.json`: the law estate, the set of",
    "# paths whose edit changes what the NEXT change is allowed to do. Adding a",
    "# law path to a pack and regenerating is the only way to add a line here.",
    "#",
    "# The host is what enforces this. A CODEOWNERS entry means something only",
    "# while branch protection requires review from code owners on the default",
    "# branch — owner-enabled, configured outside this repository. The rules under",
    "# `.governance/law/` observe; they never enforce.",
    "",
    ...globs.map((glob) => `${glob} ${OWNER}`),
    "",
  ].join("\n");
}

/**
 * What is on disk, or `null` when the file does not exist.
 *
 * @returns {string|null} The current contents.
 */
export function current() {
  try {
    return readFileSync(path.join(ROOT, CODEOWNERS_PATH), "utf8");
  } catch {
    return null;
  }
}

/**
 * Whether the file on disk is what this generator would write.
 *
 * @returns {{inSync: boolean, paths: number}} The state.
 */
export function status() {
  const globs = lawPaths();
  return { inSync: current() === render(globs), paths: globs.length };
}

/**
 * The CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {number} The exit code.
 */
export function main(argv: string[]) {
  const text = render();
  if (argv.includes("--write")) {
    writeFileSync(path.join(ROOT, CODEOWNERS_PATH), text);
    process.stdout.write(`wrote ${CODEOWNERS_PATH} (${lawPaths().length} law paths)\n`);
    return 0;
  }
  if (argv.includes("--check")) {
    const drifted = current() !== text;
    process.stdout.write(
      drifted
        ? `✗ ${CODEOWNERS_PATH} has drifted from the law estate — run 'node .governance/law/codeowners.ts --write'\n`
        : `✓ ${CODEOWNERS_PATH} in sync (${lawPaths().length} law paths)\n`
    );
    return drifted ? 1 : 0;
  }
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
