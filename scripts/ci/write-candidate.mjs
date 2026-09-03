#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

export const HISTORY_LIMIT = 200;

export function laneVerdicts(needs) {
  const out = {};
  if (!needs || typeof needs !== "object") return out;
  for (const [lane, value] of Object.entries(needs)) {
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

export function appendHistory(existing, entry) {
  const previous = Array.isArray(existing?.candidates)
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
