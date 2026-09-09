#!/usr/bin/env node
// The arrival record: everything about a change that a pure rule cannot ask git
// for itself (#1005).
//
// The split is the point. Rules stay synchronous functions over a document, so
// they are testable with `RuleTester`, suppressible with a comment, and cheap
// enough to run at pre-commit. Everything that needs git, the network or the
// clock happens here, once, and lands in `out/arrival.json` — which is then
// just another document the law lints.
//
// The output is DETERMINISTIC: no timestamps, no absolute paths, arrays sorted
// bytewise, object keys in a fixed construction order. Two runs over the same
// range in the same tree are byte-identical, which is what lets a fixture pin
// the generator.
//
// Usage:
//   node .governance/law/arrival.mjs [--range A..B] [--message-file F]
//                                    [--out P] [--stamp key=value]...
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { git, parseNameStatus } from "./lib/git.mjs";
import { collectFrozen, collectReceipts, collectWaivers } from "./lib/registries.mjs";
import { collectManagedTree } from "./lib/managed.mjs";
import { byteCompare, globToRegExp, lawDigest } from "./lib/digest.mjs";
import { readPacks } from "./eslint.config.mjs";

// Re-exported so the generator stays one import for its callers and its tests,
// even though its sections live in one file each.
export {
  collectFrozen,
  collectReceipts,
  collectWaivers,
  documentIntegrityRules,
  extractSection,
} from "./lib/registries.mjs";
export { collectManagedTree, parseManagedDigests, parsePacksLock } from "./lib/managed.mjs";
export { parseNameStatus } from "./lib/git.mjs";

const HERE = import.meta.dirname;

/**
 * The schema version of the record this generator writes.
 *
 * 2 (#1005 lane B) added `range.hasBase`, `waivers`, `registries.frozen` and
 * `registries.receipts` when the vendored `governance-kit/audit` pack was
 * ported to rules.
 */
export const SCHEMA = 2;

/** Branch names the ported directives treated as the trunk. */
const DEFAULT_BRANCHES = Object.freeze(["origin/main", "origin/master", "main", "master"]);

/**
 * Resolve the range to report on.
 *
 * The default is the change as a reviewer sees it: everything since this branch
 * left the trunk. Without an `origin/main` to fork from (a fresh clone, a
 * detached CI checkout) it falls back to the last commit, which is the smallest
 * honest answer rather than the whole history.
 *
 * @param {string} [explicit] A `base..head` string from `--range`.
 * @returns {{base: string, head: string, mergeBase: string|null}} Resolved oids.
 */
export function resolveRange(explicit) {
  if (explicit) {
    const [base, head = "HEAD"] = explicit.split("..");
    const resolved = { base: git(["rev-parse", base]), head: git(["rev-parse", head]) };
    return { ...resolved, mergeBase: resolved.base, hasBase: resolved.base !== resolved.head };
  }
  const head = git(["rev-parse", "HEAD"]);
  // The ported directives all walked this same candidate list and all treated
  // "the merge-base is HEAD" as "there is no new work" — the case that makes
  // them skip. `hasBase` carries that distinction into the record so a rule
  // reproduces the skip without asking git anything.
  for (const candidate of DEFAULT_BRANCHES) {
    try {
      git(["rev-parse", "--verify", candidate]);
    } catch {
      continue;
    }
    let mergeBase;
    try {
      mergeBase = git(["merge-base", "HEAD", candidate]);
    } catch {
      continue;
    }
    if (mergeBase && mergeBase !== head) {
      return { base: mergeBase, head, mergeBase, hasBase: true };
    }
  }
  // No new work against a trunk. The range is the tip commit alone — which is
  // exactly what `commit-message-format`'s fallback validated — and `hasBase`
  // is false, which is what makes `doc-integrity` skip.
  let base = head;
  try {
    base = git(["rev-parse", "HEAD~1"]);
  } catch {
    base = head;
  }
  return { base, head, mergeBase: null, hasBase: false };
}

/**
 * Every commit in the range, oldest first, with its own file list.
 *
 * @param {{base: string, head: string}} range The resolved range.
 * @returns {{sha: string, subject: string, body: string, parents: string[], files: object[]}[]}
 *   The commits.
 */
export function collectCommits(range) {
  const shas = git(["rev-list", "--reverse", `${range.base}..${range.head}`])
    .split("\n")
    .filter(Boolean);
  return shas.map((sha) => {
    const [parents, authorEmail, subject, ...bodyLines] = git([
      "show",
      "-s",
      "--format=%P%n%ae%n%s%n%b",
      sha,
    ]).split("\n");
    return {
      sha,
      authorEmail,
      subject,
      body: bodyLines.join("\n").replace(/\n+$/u, ""),
      parents: parents.split(" ").filter(Boolean),
      // A merge commit has no single diff, so `diff-tree` prints nothing for
      // one. That is the honest answer: its content is its parents'.
      files: parseNameStatus(
        git(["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", sha])
      ),
    };
  });
}

/**
 * The uncommitted change, when a commit message is being written.
 *
 * @param {string|null} messageFile Path passed to `--message-file`.
 * @returns {{message: string, files: object[]}|null} The pending commit, or null.
 */
export function collectPending(messageFile) {
  if (!messageFile) return null;
  // Comment lines are git's own scaffolding, not the author's message.
  const message = readFileSync(messageFile, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .replace(/\n+$/u, "");
  return {
    message,
    files: parseNameStatus(git(["diff", "--cached", "-z", "--name-status"])),
  };
}

/**
 * `git ls-tree -r` at one revision, as `{path, sha}` rows.
 *
 * @param {string} rev The revision.
 * @returns {{path: string, sha: string}[]} Every tracked blob.
 */
function treeEntries(rev) {
  return git(["ls-tree", "-r", "-z", rev])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      // `<mode> <type> <sha>` — the third field is the blob's oid.
      const sha = meta.split(" ")[2];
      return { path: file, sha };
    });
}

/**
 * The law section: what counts as law, and whether it moved under this change.
 *
 * A change that edits the rules it is judged by is not the same kind of change
 * as one that does not, and only the owner can tell the two apart — so the
 * record states it rather than deciding it.
 *
 * @param {{base: string, head: string}} range The resolved range.
 * @returns {{paths: string[], digestAtBase: string, digestAtHead: string, changed: string[]}}
 *   The law section.
 */
export function collectLaw(range) {
  const globs = readPacks()
    .flatMap((pack) => pack.lawPaths)
    .sort(byteCompare);
  const matchers = globs.map(globToRegExp);
  const atBase = lawDigest(treeEntries(range.base), matchers);
  const atHead = lawDigest(treeEntries(range.head), matchers);
  const changed =
    atBase.digest === atHead.digest
      ? []
      : parseNameStatus(
          git([
            "diff",
            "-z",
            "--name-status",
            `${range.base}..${range.head}`,
          ])
        )
          .map((row) => row.path)
          .filter((file) => matchers.some((matcher) => matcher.test(file)))
          .sort(byteCompare);
  return {
    paths: globs,
    digestAtBase: atBase.digest,
    digestAtHead: atHead.digest,
    changed,
  };
}

/**
 * Build the whole record.
 *
 * One function per section, and every section present even when this lane does
 * not fill it: a consumer that has to ask whether a key exists before reading
 * it is a consumer that will get it wrong once.
 *
 * @param {object} [options] Generation options.
 * @param {string} [options.range] `base..head`.
 * @param {string} [options.messageFile] A commit message being written.
 * @param {Record<string, string>} [options.stamp] Extra `key=value` facts.
 * @returns {object} The arrival record.
 */
export function buildArrival(options = {}) {
  const range = resolveRange(options.range);
  const commits = collectCommits(range);
  const pending = collectPending(options.messageFile ?? null);
  return {
    schema: SCHEMA,
    range,
    commits,
    files: parseNameStatus(
      git(["diff", "-z", "--name-status", `${range.base}..${range.head}`])
    ),
    pending,
    law: collectLaw(range),
    managedTree: collectManagedTree(),
    waivers: collectWaivers(commits, pending),
    registries: {
      frozen: collectFrozen(range, pending !== null),
      receipts: collectReceipts(range, pending),
    },
    gates: [],
    ci: { issueExists: null, issueIsProposal: null, prAuthorIsOwner: null },
    ...(options.stamp && Object.keys(options.stamp).length > 0
      ? { stamp: options.stamp }
      : {}),
  };
}

/**
 * Serialize a record the one way it is ever written.
 *
 * @param {object} arrival The record.
 * @returns {string} Pretty JSON with a trailing newline.
 */
export function serialize(arrival) {
  return `${JSON.stringify(arrival, null, 2)}\n`;
}

/**
 * Parse argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{range?: string, messageFile?: string, out: string, stamp: object}} Options.
 */
export function parseArgs(argv) {
  const options = { out: path.join(HERE, "out", "arrival.json"), stamp: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--range") options.range = argv[(i += 1)];
    else if (arg === "--message-file") options.messageFile = argv[(i += 1)];
    else if (arg === "--out") options.out = argv[(i += 1)];
    else if (arg === "--stamp") {
      const [key, ...rest] = argv[(i += 1)].split("=");
      options.stamp[key] = rest.join("=");
    } else throw new Error(`arrival: unknown argument ${arg}`);
  }
  return options;
}

/**
 * Generate the record and write it.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {string} The path written.
 */
export function main(argv) {
  const options = parseArgs(argv);
  const arrival = buildArrival(options);
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, serialize(arrival));
  return options.out;
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(`${main(process.argv.slice(2))}\n`);
}
