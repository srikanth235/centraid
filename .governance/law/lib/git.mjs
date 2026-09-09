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
  // stderr is captured, not inherited: probing for a ref that does not exist is
  // a normal step here, and a stray `fatal: Needed a single revision` printed
  // into a governance run reads as a failure that did not happen.
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/u, "");
}

/**
 * Run git and return raw bytes, for blobs that are not text.
 *
 * @param {string[]} args The argument vector.
 * @returns {Buffer} stdout.
 */
export function gitBytes(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

/**
 * Read many blobs in one `git cat-file --batch`.
 *
 * One process for the whole receipts corpus, not one per file: the record is
 * generated on the pre-commit rung, and 380 `git show` invocations cost seconds
 * where a single batch costs milliseconds.
 *
 * @param {string[]} specs Object specs (`<rev>:<path>`, or `:<path>` for the index).
 * @returns {Map<string, Buffer|null>} spec → bytes, or null when absent.
 */
export function readBlobs(specs) {
  const out = new Map();
  if (specs.length === 0) return out;
  const stdout = execFileSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: `${specs.join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let offset = 0;
  for (const spec of specs) {
    const end = stdout.indexOf(10, offset);
    const header = stdout.toString("utf8", offset, end);
    offset = end + 1;
    // `<oid> <type> <size>` for a hit; `<spec> missing` (or `ambiguous`) for a
    // miss, and a miss carries no body to skip over.
    const fields = header.split(" ");
    if (fields.length < 3) {
      out.set(spec, null);
      continue;
    }
    const size = Number(fields[2]);
    out.set(spec, stdout.subarray(offset, offset + size));
    offset += size + 1;
  }
  return out;
}

/**
 * A read-only view of one tree: the head of the range, or the index.
 *
 * Every working-tree read the generator used to do goes through one of these,
 * which is what makes the record a function of its inputs. `rev` is a revision
 * for a `--range` run and `null` inside the commit hook, where the tree being
 * judged is the one the author staged.
 *
 * @param {string|null} rev The revision, or null for the index.
 * @returns {{rev: string|null, list: (pathspec?: string[]) => string[], read: (files: string[]) => Map<string, Buffer|null>}}
 *   The reader.
 */
export function treeSource(rev) {
  const prefix = rev === null ? ":" : `${rev}:`;
  return {
    rev,
    list(pathspec = []) {
      const args =
        rev === null
          ? ["ls-files", "-z", "--", ...pathspec]
          : ["ls-tree", "-r", "--name-only", "-z", rev, "--", ...pathspec];
      return git(args).split("\0").filter(Boolean);
    },
    read(files) {
      const blobs = readBlobs(files.map((file) => `${prefix}${file}`));
      return new Map(files.map((file) => [file, blobs.get(`${prefix}${file}`) ?? null]));
    },
  };
}
