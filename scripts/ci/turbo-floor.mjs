#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const GLOBAL_HASH_INPUTS = Object.freeze([
  "bun.lock",
  "package.json",
  "turbo.json",
  ".npmrc",
  "bunfig.toml",
  "Cargo.lock",
  ".node-version",
]);

export const GLOBAL_HASH_PREFIXES = Object.freeze([".github/actions/setup/"]);

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

export function parseDiffOutput(stdout) {
  return (stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function decideFloor({ files, minHitRate }) {
  if (files === null) {
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
