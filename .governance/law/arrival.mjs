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

import { git, parseNameStatus, treeSource } from "./lib/git.mjs";
import {
  collectDocket,
  collectDocument,
  collectFrozen,
  collectReceipts,
} from "./lib/registries.mjs";
import { collectWaivers } from "./lib/waivers.mjs";
import { collectGates } from "./lib/gates.mjs";
import { estateClassifier, tagEstates } from "./lib/estates.mjs";
import { collectManagedTree } from "./lib/managed.mjs";
import { byteCompare, globToRegExp, lawDigest } from "./lib/digest.mjs";
import { readPacks } from "./eslint.config.mjs";

// Re-exported so the generator stays one import for its callers and its tests,
// even though its sections live in one file each.
export { collectGates, isLedger, judgeDeviation, judgeSection } from "./lib/gates.mjs";
export { ESTATES, estateClassifier, estatesOf, tagEstates } from "./lib/estates.mjs";
export {
  collectDocket,
  collectDocument,
  collectFrozen,
  collectReceipts,
  collectCites,
  collectRulings,
  documentIntegrityRules,
  extractReceiptSection,
  extractSection,
} from "./lib/registries.mjs";
export {
  addedLinesByFile,
  collectWaivers,
  collectWaiversFromLines,
} from "./lib/waivers.mjs";
export { collectManagedTree, parseManagedDigests, parsePacksLock } from "./lib/managed.mjs";
export { parseNameStatus } from "./lib/git.mjs";

const HERE = import.meta.dirname;

/**
 * The schema version of the record this generator writes.
 *
 * 2 (#1005 lane B) added `range.hasBase`, `waivers`, `registries.frozen` and
 * `registries.receipts` when the vendored `governance-kit/audit` pack was
 * ported to rules.
 *
 * 3 (#1005 lane C) tagged every file row with its `estate`, filled `gates` with
 * the tighten-only ledgers this change moved and which way, and added
 * `registries.changelog`, `registries.decisions` and `registries.docket`.
 *
 * 4 (#1005 lane D) reads every place a waiver can be written — a commit body, a
 * comment on a line the change added, an `eslint-disable` directive in a
 * governance document — into one `waivers` list carrying its `docket` id; adds
 * `registries.docket.rowsOnBase`, the ids the docket held at the baseline; and
 * records `registries.receipts[*].rulings` for the receipts this change
 * touched.
 *
 * 6 (#1005 lane F) makes the record a function of exactly its inputs — the
 * range, and the pending commit when there is one. The receipt corpus, the
 * docket and the managed tree are read at the range's head (or out of the index
 * inside the commit hook) instead of out of the working copy, `range` carries
 * `onDefaultBranch` (a fact only a pending run has), and
 * `registries.receipts.change` drops `branch`, `onDefaultBranch` and
 * `hasStaged` for a single `completed` (R-1005-27).
 *
 * 5 (#1005 lane D) carries the law's own declarations into the record so the
 * rules that judge amendments and citations stay pure: `law.domains` (the
 * packs' doctrine domains), `law.rules` and `law.rulesAtBase` (every declared
 * rule's severity and door, on both sides of the merge-base), and
 * `registries.receipts[*].cites`.
 */
export const SCHEMA = 6;

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
 * The law globs, compiled once.
 *
 * @returns {{globs: string[], matchers: RegExp[]}} The law paths and matchers.
 */
export function lawMatchers() {
  const globs = readPacks()
    .flatMap((pack) => pack.lawPaths)
    .sort(byteCompare);
  return { globs, matchers: globs.map(globToRegExp) };
}

/**
 * The law digest at one revision.
 *
 * Exported for `brief.mjs`, which has no range: a brief is stamped with what
 * the law WAS when it was written, and the only question later is whether HEAD
 * still matches.
 *
 * @param {string} rev The revision.
 * @returns {string} The digest.
 */
export function lawDigestAt(rev) {
  return lawDigest(treeEntries(rev), lawMatchers().matchers).digest;
}

/**
 * The law paths that changed between two revisions.
 *
 * @param {string} base The earlier revision.
 * @param {string} head The later one.
 * @returns {string[]} Sorted paths.
 */
export function lawPathsChanged(base, head) {
  const { matchers } = lawMatchers();
  return parseNameStatus(git(["diff", "-z", "--name-status", `${base}..${head}`]))
    .map((row) => row.path)
    .filter((file) => matchers.some((matcher) => matcher.test(file)))
    .sort(byteCompare);
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
  const packs = readPacks();
  const { globs, matchers } = lawMatchers();
  const atBase = lawDigest(treeEntries(range.base), matchers);
  const atHead = lawDigest(treeEntries(range.head), matchers);
  const changed =
    atBase.digest === atHead.digest ? [] : lawPathsChanged(range.base, range.head);
  return {
    paths: globs,
    digestAtBase: atBase.digest,
    digestAtHead: atHead.digest,
    changed,
    // What the packs DECLARE, carried into the record so the rules that judge
    // an amendment or a citation read one document rather than re-opening the
    // pack files a second time with a second parser.
    domains: packs
      .flatMap((pack) => pack.domains)
      .sort((a, b) => byteCompare(a.id ?? "", b.id ?? "")),
    rules: declaredRules(packs),
    rulesAtBase: declaredRulesAt(packs, range.base),
  };
}

/**
 * Every rule a pack declares, as `id → {severity, door}`.
 *
 * Rules declared `off` are included: a repeal is exactly the change
 * `amendment-pairing` must be able to see.
 *
 * @param {object[]} packs The parsed packs.
 * @returns {Record<string, {severity: string|null, door: string|null}>} The map.
 */
export function declaredRules(packs) {
  const rows = {};
  for (const pack of packs) {
    for (const [id, row] of Object.entries(pack.rules ?? {})) {
      rows[id] = { severity: row?.severity ?? null, door: row?.door ?? null };
    }
  }
  return Object.fromEntries(Object.entries(rows).sort(([a], [b]) => byteCompare(a, b)));
}

/**
 * The same map, as it stood at a revision.
 *
 * A pack file that did not exist there contributes nothing, which reads as
 * "every rule it declares is new" — the honest answer for a pack this change
 * introduced.
 *
 * @param {object[]} packs The parsed packs, for their file paths.
 * @param {string} rev The revision.
 * @returns {Record<string, {severity: string|null, door: string|null}>} The map.
 */
export function declaredRulesAt(packs, rev) {
  const at = [];
  for (const pack of packs) {
    const relative = path.relative(path.resolve(HERE, "..", ".."), pack.file);
    try {
      at.push(JSON.parse(git(["show", `${rev}:${relative}`])));
    } catch {
      // Absent at that revision.
    }
  }
  return declaredRules(at);
}

/**
 * Whether a commit in flight is being made straight onto the trunk.
 *
 * Only ever asked for a pending run. A `--range` run answers `null`: which
 * branch a checkout happens to be on is not a fact about the change, and a
 * record that carried it said a different thing on every machine that
 * generated it (R-1005-27).
 *
 * @param {object|null} pending The pending commit, if any.
 * @returns {boolean|null} True on the trunk, false elsewhere, null off the hook.
 */
function onTrunk(pending) {
  if (pending === null) return null;
  try {
    const branch = git(["symbolic-ref", "--short", "HEAD"]);
    return branch === "main" || branch === "master";
  } catch {
    return false;
  }
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
 * @returns {Promise<object>} The arrival record.
 */
export async function buildArrival(options = {}) {
  const rawPending = collectPending(options.messageFile ?? null);
  // The one fact about the checkout the record may hold, and only when a commit
  // is being written: a commit landing straight on the trunk is a completed
  // change, and the hook is the only door that can know it. In a `--range` run
  // it is `null` and `completed` derives from the range alone (R-1005-27).
  const range = { ...resolveRange(options.range), onDefaultBranch: onTrunk(rawPending) };
  // The tree the record is about: the range's head, or the index when a commit
  // is in flight — the commit being written is judged on what it stages.
  const source = treeSource(rawPending === null ? range.head : null);
  const rawCommits = collectCommits(range);
  // One classifier for the whole record: #1002's squash alone carries 1022
  // paths, and compiling the law globs once per file list is the difference
  // between a generator that fits the pre-commit rung and one that does not.
  const classify = estateClassifier();
  const commits = rawCommits.map((commit) => ({
    ...commit,
    files: tagEstates(commit.files, classify),
  }));
  const pending =
    rawPending === null ? null : { ...rawPending, files: tagEstates(rawPending.files, classify) };
  const files = tagEstates(
    parseNameStatus(git(["diff", "-z", "--name-status", `${range.base}..${range.head}`])),
    classify
  );
  const law = collectLaw(range);
  return {
    schema: SCHEMA,
    range,
    commits,
    files,
    pending,
    law,
    managedTree: collectManagedTree(source),
    waivers: collectWaivers(commits, pending, range),
    registries: {
      frozen: collectFrozen(range, pending !== null),
      receipts: collectReceipts(range, pending, source),
      changelog: collectDocument(range, pending, "CHANGELOG.md"),
      decisions: collectDocument(range, pending, "docs/decisions.md"),
      docket: collectDocket(range, source),
    },
    // Every ledger this change moved, from the aggregate law diff and from the
    // staged set — the hook door sees only the latter, and a knob loosened in
    // the commit being written is exactly what it is there to notice.
    gates: await collectGates(
      range,
      [...new Set([...law.changed, ...(pending?.files ?? []).map((row) => row.path)])],
      commits,
      pending !== null
    ),
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
 * @returns {Promise<string>} The path written.
 */
export async function main(argv) {
  const options = parseArgs(argv);
  const arrival = await buildArrival(options);
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, serialize(arrival));
  return options.out;
}

if (process.argv[1] === import.meta.filename) {
  process.stdout.write(`${await main(process.argv.slice(2))}\n`);
}
