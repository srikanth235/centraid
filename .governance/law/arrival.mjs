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
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { byteCompare, dirDigest, globToRegExp, lawDigest, sha256File } from "./lib/digest.mjs";
import { readPacks } from "./eslint.config.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");

/** The schema version of the record this generator writes. */
export const SCHEMA = 1;

/**
 * Run git in the repository root and return trimmed stdout.
 *
 * @param {string[]} args The argument vector.
 * @returns {string} stdout, trailing newline removed.
 */
function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\n$/u, "");
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
    return {
      base: git(["rev-parse", base]),
      head: git(["rev-parse", head]),
      mergeBase: null,
    };
  }
  const head = git(["rev-parse", "HEAD"]);
  try {
    const mergeBase = git(["merge-base", "HEAD", "origin/main"]);
    return { base: mergeBase, head, mergeBase };
  } catch {
    return { base: git(["rev-parse", "HEAD~1"]), head, mergeBase: null };
  }
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
    const [parents, subject, ...bodyLines] = git([
      "show",
      "-s",
      "--format=%P%n%s%n%b",
      sha,
    ]).split("\n");
    return {
      sha,
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
 * Read the `digest:` maps out of `.governance/packs.lock`.
 *
 * A narrow line parser, not a YAML implementation: this file is generated by
 * the kit in one shape, and a dependency for reading four known keys would be a
 * dependency the commit path pays for on every run.
 *
 * @param {string} text The lockfile.
 * @returns {{id: string, digest: Record<string, string>}[]} The packs.
 */
export function parsePacksLock(text) {
  const packs = [];
  let current = null;
  let inDigest = false;
  for (const line of text.split("\n")) {
    const entry = /^- id: (?<id>.+)$/u.exec(line);
    if (entry) {
      current = { id: entry.groups.id.trim(), digest: {} };
      packs.push(current);
      inDigest = false;
      continue;
    }
    if (!current) continue;
    if (/^ {2}digest:\s*$/u.test(line)) {
      inDigest = true;
      continue;
    }
    if (inDigest) {
      const row = /^ {4}(?<key>[^:]+): (?<value>.+)$/u.exec(line);
      if (row) current.digest[row.groups.key.trim()] = row.groups.value.trim();
      else if (/^\S/u.test(line) || /^ {2}\S/u.test(line)) inDigest = false;
    }
  }
  return packs;
}

/**
 * Read `managed_digests:` out of `.governance/install.yaml`. Same narrowness,
 * same reason as `parsePacksLock`.
 *
 * @param {string} text The install manifest.
 * @returns {Record<string, string>} path → recorded digest.
 */
export function parseManagedDigests(text) {
  const out = {};
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^managed_digests:\s*$/u.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const row = /^ {2}(?<key>[^:\s]+): (?<value>.+)$/u.exec(line);
    if (row) out[row.groups.key] = row.groups.value.trim();
    else if (line.trim() !== "") break;
  }
  return out;
}

/**
 * The managed-tree section: recorded digest against actual, for every unit the
 * kit locks. `managed-tree-integrity` already fails a commit on a mismatch;
 * this repeats the arithmetic so a rule can *reason* about it — which unit
 * moved, and whether the change set explains it.
 *
 * @returns {{packs: object[], files: object[]}} The section.
 */
export function collectManagedTree() {
  const packs = [];
  for (const pack of parsePacksLock(
    readFileSync(path.join(ROOT, ".governance/packs.lock"), "utf8")
  )) {
    const [owner, name] = pack.id.split("/");
    for (const directive of Object.keys(pack.digest).sort(byteCompare)) {
      packs.push({
        id: pack.id,
        directive,
        recorded: pack.digest[directive],
        actual: dirDigest(
          path.join(ROOT, ".governance/packs", owner, name, "directives", directive)
        ),
      });
    }
  }
  const recorded = parseManagedDigests(
    readFileSync(path.join(ROOT, ".governance/install.yaml"), "utf8")
  );
  const files = Object.keys(recorded)
    .sort(byteCompare)
    .map((file) => {
      let actual = "";
      try {
        actual = sha256File(path.join(ROOT, file));
      } catch {
        actual = "";
      }
      return { path: file, recorded: recorded[file], actual };
    });
  return { packs, files };
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
  return {
    schema: SCHEMA,
    range,
    commits: collectCommits(range),
    files: parseNameStatus(
      git(["diff", "-z", "--name-status", `${range.base}..${range.head}`])
    ),
    pending: collectPending(options.messageFile ?? null),
    law: collectLaw(range),
    managedTree: collectManagedTree(),
    // Filled by later waves; present from the first record so a rule can read
    // them without an existence check.
    waivers: [],
    registries: {},
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
