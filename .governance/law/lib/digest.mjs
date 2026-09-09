// The digest algorithms the arrival record reports on (#1005).
//
// `dirDigest` MUST stay byte-identical to
// `.governance/packs/governance-kit/audit/directives/managed-tree-integrity/lib/digest.sh`,
// which is itself pinned to the kit's Python copy. It is reproduced here rather
// than shelled out to because the arrival record is generated once and read by
// pure, synchronous rules; `arrival.test.mjs` pins the two implementations
// together by running the bash function and comparing.
//
//   file digest      = sha256 hex of the file's raw bytes.
//   directory digest = sha256 over, for each KEPT file sorted bytewise by
//                      posix relpath: <relpath> + NUL + <sha256 hex> + '\n'.
//                      KEPT excludes any path with a component (the filename
//                      included) equal to "evals", "install-assets" or
//                      "__pycache__", and any file whose name ends in ".pyc".
//   An empty or missing directory digests to the empty string — not the
//   sha256 of zero bytes.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Path components the managed-tree digest never sees. */
const EXCLUDED_COMPONENTS = new Set(["evals", "install-assets", "__pycache__"]);

/**
 * Bytewise comparator, matching `LC_ALL=C sort` and Python's `sorted()` over
 * the ASCII relpaths this tree produces. `Array#sort`'s default is UTF-16 code
 * units, which differs the moment a path is not ASCII.
 *
 * @param {string} a Left path.
 * @param {string} b Right path.
 * @returns {number} Negative, zero or positive.
 */
export function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * sha256 hex of a buffer or string.
 *
 * @param {Buffer|string} data The bytes.
 * @returns {string} Lowercase hex.
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * sha256 hex of a file's raw bytes.
 *
 * @param {string} file Absolute or cwd-relative path.
 * @returns {string} Lowercase hex.
 */
export function sha256File(file) {
  return sha256(readFileSync(file));
}

/**
 * Every file under `dir`, as posix relpaths, with nothing excluded yet.
 *
 * @param {string} dir The directory.
 * @param {string} [prefix] Internal: the relpath of `dir` itself.
 * @returns {string[]} Relpaths, unsorted.
 */
function walk(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // `find -type f` follows neither directory symlinks nor counts them as
    // files; a symlink to a file is not a regular file either.
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * The managed-tree digest of a directory.
 *
 * @param {string} dir The directory. Missing or empty digests to "".
 * @returns {string} Lowercase hex, or "".
 */
export function dirDigest(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return "";
  }
  if (!stat.isDirectory()) return "";
  const kept = walk(dir)
    .filter((rel) => {
      const parts = rel.split("/");
      if (parts.some((part) => EXCLUDED_COMPONENTS.has(part))) return false;
      return !parts[parts.length - 1].endsWith(".pyc");
    })
    .sort(byteCompare);
  if (kept.length === 0) return "";
  const hash = createHash("sha256");
  for (const rel of kept) {
    hash.update(Buffer.from(rel, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(`${sha256File(path.join(dir, rel))}\n`);
  }
  return hash.digest("hex");
}

/**
 * Compile one glob to an anchored RegExp.
 *
 * Supports exactly what a pack's `lawPaths` uses: `**` (any depth, including
 * none) and `*` (within one segment). Anything else is matched literally, so a
 * pattern this function does not understand under-matches rather than
 * over-matching — a law digest that silently covered more paths than declared
 * would be worse than one that covered fewer and said so.
 *
 * @param {string} glob The pattern, relative and `/`-separated.
 * @returns {RegExp} The matcher.
 */
export function globToRegExp(glob) {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
      continue;
    }
    if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    out += glob[i].replace(/[.+^${}()|[\]\\?]/gu, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`, "u");
}

/**
 * Does `file` fall under any of `globs`?
 *
 * @param {string} file A repo-relative path.
 * @param {RegExp[]} matchers Compiled patterns.
 * @returns {boolean} True when any matches.
 */
export function matchesAny(file, matchers) {
  return matchers.some((matcher) => matcher.test(file));
}

/**
 * The law digest: sha256 over the sorted (path, blob sha) of every tracked file
 * at `rev` that a declared law path matches.
 *
 * It reads the object database, never the working tree, so it can be computed
 * for any revision without a checkout — which is what makes "did the law itself
 * move under this change?" a question the arrival record can answer.
 *
 * @param {{path: string, sha: string}[]} entries `git ls-tree -r` rows at rev.
 * @param {RegExp[]} matchers The compiled law paths.
 * @returns {{digest: string, paths: string[]}} The digest and what it covered.
 */
export function lawDigest(entries, matchers) {
  const covered = entries
    .filter((entry) => matchesAny(entry.path, matchers))
    .sort((a, b) => byteCompare(a.path, b.path));
  if (covered.length === 0) return { digest: "", paths: [] };
  const hash = createHash("sha256");
  for (const entry of covered) {
    hash.update(Buffer.from(entry.path, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(`${entry.sha}\n`);
  }
  return { digest: hash.digest("hex"), paths: covered.map((entry) => entry.path) };
}
