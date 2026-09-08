#!/usr/bin/env node
/**
 * The turbo cache-hit floor, waived precisely rather than waivably (#915).
 *
 * WHY A WRAPPER EXISTS AT ALL. `--min-hit-rate 0.15` is a real gate: with
 * `turbo.json`'s `build.inputs` fixed, the deepest legitimate single-package
 * change (`packages/core/src`) still leaves 3 of 13 build tasks cached (~23%),
 * so anything below the floor is a whole-graph miss worth reding.
 *
 * There is exactly ONE legitimate way to be below it: a change to a GLOBAL HASH
 * INPUT. Turbo's global hash covers the lockfile, the root manifest, the turbo
 * config and the toolchain; move any of them and every task misses by design.
 * Reding every dependency bump would make this a gate that is always red on the
 * PRs that need it least — #915 principle 2 says a gate that is always red is
 * off, and the scorecard's PR false-red target is <= 2%.
 *
 * So the waiver is COMPUTED, not offered. There is no environment variable and
 * no flag that turns the floor off: this reads the diff, and only a diff that
 * actually touches a global-hash input downgrades the failure to a warning that
 * NAMES THE FILE. Everything else enforces. A waiver nobody can invoke by hand
 * is the difference between an exception and a hole.
 *
 * Usage:
 *   node scripts/ci/turbo-floor.mjs --min-hit-rate 0.15 [--task build]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Paths whose contents feed turbo's GLOBAL hash — the one that invalidates
 * every task at once rather than one package's.
 *
 * Held as a literal list because each entry is a decision: `bun.lock` and the
 * root `package.json` carry `hashOfExternalDependencies` and the
 * `packageManager` pin, `turbo.json` is the task graph itself, the setup action
 * pins Bun and Node (and `engines`/`.node-version` reach the global hash through
 * it), and the Rust toolchain/lockfile decide what `@centraid/tunnel#build`
 * compiles. Adding a path here weakens the floor for diffs that touch it, so
 * add one only when a run has PROVED it moves the global hash — the `### Turbo
 * cache` step summary prints `globalCacheInputs` for exactly this purpose.
 */
export const GLOBAL_HASH_INPUTS = Object.freeze([
  "bun.lock",
  "package.json",
  "turbo.json",
  ".npmrc",
  "bunfig.toml",
  "Cargo.lock",
  ".node-version",
]);

/** Directory prefixes that are global-hash inputs in their entirety. */
export const GLOBAL_HASH_PREFIXES = Object.freeze([".github/actions/setup/"]);

/**
 * Which changed paths move turbo's global hash.
 *
 * ROOT-ONLY for the bare filenames: `packages/core/package.json` changes ONE
 * package's hash and is exactly the case the floor is meant to catch, while the
 * root manifest changes all of them. Treating them alike would waive the floor
 * on most PRs in the repo.
 *
 * @param {string[]} files Repository-relative changed paths.
 * @returns {string[]} The subset that moves the global hash, in input order.
 */
export function globalHashInputsIn(files) {
  const changed = new Set(files.map((file) => file.trim()).filter(Boolean));
  const hits = [];
  for (const input of GLOBAL_HASH_INPUTS) {
    if (changed.has(input)) hits.push(input);
  }
  for (const file of changed) {
    if (
      GLOBAL_HASH_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      /^rust-toolchain(?<toml>\.toml)?$/u.test(file)
    ) {
      hits.push(file);
    }
  }
  return [...new Set(hits)];
}

/**
 * Split `git diff --name-only` output into paths.
 *
 * @param {string} stdout Raw output.
 * @returns {string[]} Paths.
 */
export function parseDiffOutput(stdout) {
  return (stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Decide whether to enforce the floor, and say why either way.
 *
 * @param {{files: string[]|null, minHitRate: number}} input The diff (null when unreadable) and the floor.
 * @returns {{enforce: boolean, minHitRate: number, reason: string, movers: string[]}} The decision.
 */
export function decideFloor({ files, minHitRate }) {
  if (files === null) {
    // Unreadable diff waives rather than enforces. The alternative reds a lane
    // for a fact about the checkout depth, which is a false red about something
    // the author cannot fix from the PR — the exact shape this wrapper exists
    // to remove. It is loud, so a lane that silently stops enforcing is visible
    // on the run page rather than only in a hit-rate nobody reads.
    return {
      enforce: false,
      minHitRate,
      movers: [],
      reason:
        "the diff could not be read (shallow checkout, or no `origin/main`), so the floor cannot tell a dependency bump from a cache regression and is not enforced this run",
    };
  }
  const movers = globalHashInputsIn(files);
  if (movers.length > 0) {
    return {
      enforce: false,
      minHitRate,
      movers,
      reason: `this diff changes ${movers.map((m) => `\`${m}\``).join(", ")}, which move turbo's GLOBAL hash — every task misses by design, so the floor would red a correct change`,
    };
  }
  return {
    enforce: true,
    minHitRate,
    movers: [],
    reason: `no global-hash input changed, so a hit rate below ${(minHitRate * 100).toFixed(0)}% is a cache regression rather than an expected miss`,
  };
}

/** Markdown for the Job Summary. */
export function renderFloorDecision(decision) {
  return [
    "### Turbo cache floor",
    "",
    decision.enforce
      ? `**Enforced at ${(decision.minHitRate * 100).toFixed(0)}%.** ${decision.reason}.`
      : `**Waived this run.** ${decision.reason}.`,
    "",
    decision.enforce
      ? "Below the floor, do not lower it: read the per-task table above and find what moved the hash."
      : "The waiver is computed from the diff, not requested — there is no flag or environment variable that turns this floor off.",
  ].join("\n");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

/**
 * The changed paths for this run, or null when no strategy works.
 *
 * Three strategies, best first. The merge-base three-dot diff is what the branch
 * actually changed; the two-dot diff against `origin/main` also sees what main
 * moved underneath it, which over-waives slightly and never under-waives; and
 * `HEAD~1` is the push-to-main shape. A best-effort shallow fetch runs first so
 * a depth-1 checkout still has an `origin/main` object to diff against.
 */
function changedFiles() {
  if (git(["rev-parse", "--verify", "--quiet", "origin/main"]) === null) {
    spawnSync("git", ["fetch", "--no-tags", "--depth=1", "origin", "main"], {
      cwd: root,
      stdio: "ignore",
    });
  }
  const base = git(["merge-base", "origin/main", "HEAD"]);
  if (base) {
    const diff = git(["diff", "--name-only", `${base.trim()}...HEAD`]);
    if (diff !== null) return parseDiffOutput(diff);
  }
  const twoDot = git(["diff", "--name-only", "origin/main", "HEAD"]);
  if (twoDot !== null) return parseDiffOutput(twoDot);
  const previous = git(["diff", "--name-only", "HEAD~1...HEAD"]);
  if (previous !== null) return parseDiffOutput(previous);
  return null;
}

function parseArgs(argv) {
  const out = { minHitRate: 0.15, task: "build", passthrough: [] };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) out.passthrough = argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--min-hit-rate" && own[i + 1])
      out.minHitRate = Number(own[++i]);
    else if (own[i] === "--task" && own[i + 1]) out.task = own[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const decision = decideFloor({
    files: changedFiles(),
    minHitRate: args.minHitRate,
  });

  const summary = renderFloorDecision(decision);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (!decision.enforce) {
    console.warn(
      `::warning title=Turbo cache floor waived::${decision.reason}`
    );
  }

  const report = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/ci/turbo-cache-report.mjs"),
      "--task",
      args.task,
      ...(decision.enforce
        ? ["--min-hit-rate", String(decision.minHitRate)]
        : []),
      ...(args.passthrough.length ? ["--", ...args.passthrough] : []),
    ],
    { cwd: root, stdio: "inherit" }
  );
  process.exitCode = report.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
