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
 *   node scripts/ci/write-candidate.ts --sha <40hex> --run-id 1 --run-url URL \
 *     [--previous <40hex>] [--needs <path to toJSON(needs)>] \
 *     [--out artifacts/candidate.json] [--history <path to candidates.json>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/** How many promotions the durable history keeps. */
export const HISTORY_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LaneVerdict {
  verdict: string;
  durationMs: number;
}

export interface CandidateRecord {
  schema: number;
  sha: string;
  promotedAt: string;
  previousSha: string | null;
  runId: string;
  runUrl: string;
  lanes: Record<string, unknown>;
}

export interface HistoryEntry {
  sha: string;
  promotedAt: string;
}

export interface CandidateHistory {
  schema: number;
  candidates: HistoryEntry[];
}

/**
 * Turn GitHub's `toJSON(needs)` into the candidate's per-lane verdicts.
 *
 * `skipped` becomes `skipped` rather than `passed`: a lane that did not run has
 * no opinion, and recording it as a pass is how a candidate comes to claim
 * proof it never had.
 */
export function laneVerdicts(needs: unknown): Record<string, LaneVerdict> {
  const out: Record<string, LaneVerdict> = {};
  if (!isRecord(needs)) return out;
  for (const [lane, value] of Object.entries(needs)) {
    if (lane === "promote") continue;
    const result = isRecord(value)
      ? String(value.result ?? "unknown")
      : "unknown";
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

/** The candidate record. */
export function buildCandidate({
  sha,
  previousSha,
  runId,
  runUrl,
  promotedAt,
  lanes,
}: {
  sha: string;
  previousSha: string | null;
  runId: string;
  runUrl: string;
  promotedAt: string;
  lanes: Record<string, unknown>;
}): CandidateRecord {
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

function asHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value) || typeof value.sha !== "string") return null;
  return {
    sha: value.sha,
    promotedAt: typeof value.promotedAt === "string" ? value.promotedAt : "",
  };
}

/**
 * Append a promotion to the durable history, newest first, bounded.
 *
 * Bounded because gh-pages is a git tree and an unbounded array becomes a diff
 * nobody can read; 200 promotions is well past any window the rules ask about
 * (the longest is trailing 30) while still covering a slow month.
 */
export function appendHistory(
  existing: unknown,
  entry: HistoryEntry
): CandidateHistory {
  const raw = isRecord(existing) ? existing.candidates : undefined;
  const previous = Array.isArray(raw)
    ? raw
        .map(asHistoryEntry)
        .filter((item): item is HistoryEntry => item !== null)
    : [];
  const deduped = previous.filter((item) => item.sha !== entry.sha);
  return {
    schema: 1,
    candidates: [entry, ...deduped].slice(0, HISTORY_LIMIT),
  };
}

function parseArgs(argv: string[]): {
  sha: string;
  previous: string;
  runId: string;
  runUrl: string;
  needs: string | null;
  out: string;
  history: string | null;
} {
  const out: {
    sha: string;
    previous: string;
    runId: string;
    runUrl: string;
    needs: string | null;
    out: string;
    history: string | null;
  } = {
    sha: process.env.GITHUB_SHA ?? "",
    previous: "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runUrl: "",
    needs: null,
    out: "artifacts/candidate.json",
    history: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--sha" && next !== undefined) {
      out.sha = next;
      i += 1;
    } else if (current === "--previous" && next !== undefined) {
      out.previous = next;
      i += 1;
    } else if (current === "--run-id" && next !== undefined) {
      out.runId = next;
      i += 1;
    } else if (current === "--run-url" && next !== undefined) {
      out.runUrl = next;
      i += 1;
    } else if (current === "--needs" && next !== undefined) {
      out.needs = next;
      i += 1;
    } else if (current === "--out" && next !== undefined) {
      out.out = next;
      i += 1;
    } else if (current === "--history" && next !== undefined) {
      out.history = next;
      i += 1;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const needsRaw: unknown = args.needs
    ? JSON.parse(readFileSync(path.resolve(root, args.needs), "utf8"))
    : {};
  const candidate = buildCandidate({
    sha: args.sha,
    previousSha: args.previous,
    runId: args.runId,
    runUrl: args.runUrl,
    promotedAt: new Date().toISOString(),
    lanes: laneVerdicts(needsRaw),
  });
  const outPath = path.resolve(root, args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`write-candidate: ${candidate.sha} → ${args.out}`);

  if (args.history) {
    const historyPath = path.resolve(root, args.history);
    const existing: unknown = existsSync(historyPath)
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
