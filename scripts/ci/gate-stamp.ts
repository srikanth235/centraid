#!/usr/bin/env node
// Gate stamps: a tier does not re-run against a tree it already passed (#988).
//
// Five agents share this container and each one pushes several times an hour
// from its own worktree. The static tier — `format:check`, `lint`, `turbo:lint`,
// `typecheck:affected` and the repo-wide governance directives — is a pure
// function of the tree it reads, so re-running it against a tree byte-identical
// to one it already passed answers a question that is already answered.
//
// A stamp is that answer, written outside the repository: `<tier>` passed
// against tree `<oid>` with `origin/main` at `<sha>`. Both halves are the key.
// The tree oid alone is not enough because `typecheck:affected` and
// `test:affected` filter on `[origin/main]`, so the same tree has a different
// affected set once the base moves.
//
// WHAT A STAMP MAY NOT DO. It may never make a gate weaker than not having it:
//   * CI never reads or writes stamps (`CI` in the environment disables both),
//     so the enforcing copy always recomputes from zero.
//   * A tier is stamped only when EVERY one of its gates ran and passed in the
//     same invocation. A skipped, failed, or partially-run tier writes nothing.
//   * `CENTRAID_GATE_STAMPS=0` turns stamping off. The knob only ever makes
//     more run, never less, which is why it needs no waiver.
//
// The stamp directory lives under the user's cache home, never in the repo:
// nothing here is committable, and a stale stamp must die with the cache rather
// than travel in a diff. `docs/toolchain.md` names the directory.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Gates whose verdict is a pure function of the tree and the merge base. */
export const STATIC_TIER: readonly string[] = Object.freeze([
  "format:check",
  "lint",
  "turbo:lint",
  "typecheck:affected",
]);

export interface GateResult {
  name: string;
  code: number;
}

export interface StampKey {
  tree: string;
  base: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a run's results earn the static stamp: EVERY member of the tier ran
 * in that one invocation and passed. An invocation that names a subset stamps
 * nothing — the stamp is read as a claim about the whole tier, so a partial
 * one would let the next `check:push:static` skip gates nobody ran.
 */
export function tierIsComplete(results: ReadonlyArray<GateResult>): boolean {
  return STATIC_TIER.every((gate) =>
    results.some((r) => r.name === gate && r.code === 0)
  );
}

/** Where stamps live: overridable, defaulting under the user's cache home. */
export function stampDir(): string {
  if (process.env.CENTRAID_GATE_STAMP_DIR) {
    return path.resolve(process.env.CENTRAID_GATE_STAMP_DIR);
  }
  const cacheHome =
    process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cacheHome, "centraid", "gate-stamps");
}

/** Stamps are a local convenience only; CI recomputes every tier from zero. */
export function stampsEnabled(): boolean {
  if (process.env.CI) return false;
  return process.env.CENTRAID_GATE_STAMPS !== "0";
}

function git(args: readonly string[], root: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd());
}

/**
 * The oid of a real git tree holding the working copy — tracked files with
 * their uncommitted edits, plus untracked files git would add. Built in a COPY
 * of the index so the caller's staging area is untouched and git's stat cache
 * still spares us from re-hashing every unchanged file.
 */
export function workingTreeOid(root: string): string {
  // Unique per call: node --test runs files concurrently, and Date.now()
  // collides inside one millisecond, so pid+clock would share GIT_INDEX_FILE
  // and two trees would hash as one (scripts/ci/gate-stamp.test.ts).
  const scratch = path.join(
    tmpdir(),
    `centraid-gate-stamp-${process.pid}-${randomBytes(8).toString("hex")}.index`
  );
  try {
    copyFileSync(
      path.resolve(root, git(["rev-parse", "--git-path", "index"], root)),
      scratch
    );
  } catch {
    // No index yet (a fresh clone mid-checkout): start from an empty one and
    // pay the full hash rather than refusing to produce a key.
    writeFileSync(scratch, "");
  }
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  try {
    execFileSync("git", ["add", "-A", "--", "."], { cwd: root, env });
    return execFileSync("git", ["write-tree"], {
      cwd: root,
      env,
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(scratch, { force: true });
  }
}

/**
 * The key a stamp is recorded against: the working tree and the base the
 * `[origin/main]` filters resolve against.
 */
export function stampKey(root: string): StampKey {
  let base = "none";
  try {
    // stderr is dropped: a clone with no `origin/main` is a legitimate state
    // here, and git's "ambiguous argument" fatal is not the caller's problem.
    base = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A clone with no `origin/main` (a detached CI checkout, a fork mid-fetch)
    // still gets a usable key; it just never matches one taken with a base.
  }
  return { tree: workingTreeOid(root), base };
}

const stampFile = (tier: string): string =>
  path.join(stampDir(), `${tier}.json`);

/** Whether `tier` already passed against exactly this key. */
export function isFresh(tier: string, key: StampKey): boolean {
  if (!stampsEnabled()) return false;
  try {
    const stamp: unknown = JSON.parse(readFileSync(stampFile(tier), "utf8"));
    return (
      isRecord(stamp) && stamp.tree === key.tree && stamp.base === key.base
    );
  } catch {
    // Absent, unreadable, or half-written: not fresh, so the tier runs.
    return false;
  }
}

/** Record that `tier` passed against `key`. A no-op under CI. */
export function record(tier: string, key: StampKey): void {
  if (!stampsEnabled()) return;
  try {
    mkdirSync(stampDir(), { recursive: true });
    writeFileSync(
      stampFile(tier),
      `${JSON.stringify({ tier, ...key, at: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    // An unwritable cache home costs a re-run, never a wrong verdict.
  }
}

if (process.argv[1] === import.meta.filename) {
  const [verb, tier] = process.argv.slice(2);
  if (!verb || !tier) {
    process.stderr.write(
      "gate-stamp: usage: gate-stamp.ts <check|record> <tier>\n"
    );
    process.exit(2);
  }
  const root = repoRoot();
  const key = stampKey(root);
  if (verb === "check") {
    process.exit(isFresh(tier, key) ? 0 : 1);
  } else if (verb === "record") {
    record(tier, key);
  } else {
    process.stderr.write(`gate-stamp: unknown verb '${verb}'\n`);
    process.exit(2);
  }
}
