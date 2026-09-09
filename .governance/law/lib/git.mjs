// The one place the law's generator talks to git (#1005).
//
// Every read the record needs goes through here, so the surface a rule
// ultimately depends on is one small, reviewable module rather than a `git`
// call scattered through four collectors.
import { execFileSync } from "node:child_process";
import path from "node:path";

import { byteCompare } from "./digest.mjs";

/** The repository root, resolved from this file rather than from the cwd. */
export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * Run git in the repository root and return trimmed stdout.
 *
 * @param {string[]} args The argument vector.
 * @returns {string} stdout, trailing newline removed.
 */
export function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/u, "");
}

/**
 * Run git and return raw bytes, for blobs that are not text.
 *
 * @param {string[]} args The argument vector.
 * @returns {Buffer} stdout.
 */
export function gitBytes(args) {
  return execFileSync("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Parse `--name-status -z` output into sorted `{path, status}` rows.
 *
 * `-z` because a path with a space, a quote or a newline in it is a legal path,
 * and the unquoted form would silently mis-split it.
 *
 * @param {string} raw The NUL-delimited output.
 * @returns {{path: string, status: string}[]} Sorted by path.
 */
export function parseNameStatus(raw) {
  const fields = raw.split("\0").filter((field) => field !== "");
  const rows = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    // A rename or copy carries two paths; the destination is the one that
    // exists after the change, which is the one a rule is about.
    const extra = /^[RC]/u.test(status) ? 2 : 1;
    const file = fields[i + extra];
    if (file === undefined) break;
    rows.push({ path: file, status: status[0] });
    i += extra;
  }
  return rows.sort((a, b) => byteCompare(a.path, b.path));
}
