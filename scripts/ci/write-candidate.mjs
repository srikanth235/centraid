#!/usr/bin/env node
/**
 * The candidate pointer's payload (#915 Wave 1, contract C1).
 *
 * WHAT A CANDIDATE IS. Rung 3 asks one question — "is this SHA a build we would
 * hand to a device?" — and until now nothing in the repo could answer it, so the
 * nightly ran against whatever happened to be at the tip of `main` and a red
 * night could not distinguish a product regression from the 04:00 dependency
 * merge. A candidate is the answer written down: a SHA, the moment it was
 * promoted, the SHA it replaced, and the verdict of every lane that voted.
 *
 * `refs/candidates/latest` is the pointer; this file is the receipt. The nightly,
 * the weeklies and the release chain all read one or the other, so the shape is
 * a contract rather than a convenience — see PLAN C1 and docs/release.md.
 *
 * Usage:
 *   node scripts/ci/write-candidate.mjs --sha <40hex> --run-id 1 --run-url URL \
 *     [--previous <40hex>] [--needs <path to toJSON(needs)>] \
 *     [--out artifacts/candidate.json] [--history <path to candidates.json>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/** How many promotions the durable history keeps. */
export const HISTORY_LIMIT = 200;

/**
 * Turn GitHub's `toJSON(needs)` into the candidate's per-lane verdicts.
 *
 * `skipped` becomes `skipped` rather than `passed`: a lane that did not run has
 * no opinion, and recording it as a pass is how a candidate comes to claim
 * proof it never had.
 *
 * @param {unknown} needs Parsed `toJSON(needs)`.
 * @returns {Record<string, {verdict: string, durationMs: number}>} Lane verdicts.
 */
export function laneVerdicts(needs) {
  /** @type {Record<string, {verdict: string, durationMs: number}>} */
  const out = {};
  if (!needs || typeof needs !== "object") return out;
  for (const [lane, value] of Object.entries(
    /** @type {Record<string, {result?: string}>} */ (needs)
  )) {
    if (lane === "promote") continue;
    const result = value?.result ?? "unknown";
    out[lane] = {
      verdict:
        result === "success"
          ? "passed"
          : result === "skipped"
            ? "skipped"
            : "failed",
      durationMs: 0,
    };
  }
  return out;
}

/**
 * The candidate record.
 *
 * @param {{sha: string, previousSha: string|null, runId: string, runUrl: string, promotedAt: string, lanes: Record<string, unknown>}} input Fields.
 * @returns {Record<string, unknown>} The C1-shaped record.
 */
export function buildCandidate({
  sha,
  previousSha,
  runId,
  runUrl,
  promotedAt,
  lanes,
}) {
  if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) {
    throw new Error(
      `write-candidate: --sha must be a 40-hex SHA, got \`${sha}\``
    );
  }
  if (previousSha && !/^[0-9a-f]{40}$/u.test(previousSha)) {
    throw new Error(
      `write-candidate: --previous must be a 40-hex SHA, got \`${previousSha}\``
    );
  }
  return {
    schema: 1,
    sha,
    promotedAt,
    previousSha: previousSha || null,
    runId: String(runId ?? ""),
    runUrl: String(runUrl ?? ""),
    lanes,
  };
}

/**
 * Append a promotion to the durable history, newest first, bounded.
 *
 * Bounded because gh-pages is a git tree and an unbounded array becomes a diff
 * nobody can read; 200 promotions is well past any window the rules ask about
 * (the longest is trailing 30) while still covering a slow month.
 *
 * @param {unknown} existing Parsed candidates.json, or anything unparseable.
 * @param {{sha: string, promotedAt: string}} entry The new promotion.
 * @returns {{schema: number, candidates: {sha: string, promotedAt: string}[]}} The new history.
 */
export function appendHistory(existing, entry) {
  const previous = Array.isArray(
    /** @type {{candidates?: unknown}} */ (existing)?.candidates
  )
    ? /** @type {{candidates: {sha: string, promotedAt: string}[]}} */ (
        existing
      ).candidates
    : [];
  const deduped = previous.filter((item) => item?.sha !== entry.sha);
  return {
    schema: 1,
    candidates: [entry, ...deduped].slice(0, HISTORY_LIMIT),
  };
}

function parseArgs(argv) {
  const out = {
    sha: process.env.GITHUB_SHA ?? "",
    previous: "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runUrl: "",
    needs: null,
    out: "artifacts/candidate.json",
    history: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sha" && argv[i + 1]) out.sha = argv[++i];
    else if (argv[i] === "--previous" && argv[i + 1]) out.previous = argv[++i];
    else if (argv[i] === "--run-id" && argv[i + 1]) out.runId = argv[++i];
    else if (argv[i] === "--run-url" && argv[i + 1]) out.runUrl = argv[++i];
    else if (argv[i] === "--needs" && argv[i + 1]) out.needs = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === "--history" && argv[i + 1]) out.history = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const needs = args.needs
    ? JSON.parse(readFileSync(path.resolve(root, args.needs), "utf8"))
    : {};
  const candidate = buildCandidate({
    sha: args.sha,
    previousSha: args.previous,
    runId: args.runId,
    runUrl: args.runUrl,
    promotedAt: new Date().toISOString(),
    lanes: laneVerdicts(needs),
  });
  const outPath = path.resolve(root, args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`write-candidate: ${candidate.sha} → ${args.out}`);

  if (args.history) {
    const historyPath = path.resolve(root, args.history);
    const existing = existsSync(historyPath)
      ? JSON.parse(readFileSync(historyPath, "utf8"))
      : null;
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(
      historyPath,
      `${JSON.stringify(
        appendHistory(existing, {
          sha: candidate.sha,
          promotedAt: candidate.promotedAt,
        }),
        null,
        2
      )}\n`
    );
    console.log(`write-candidate: history → ${args.history}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
