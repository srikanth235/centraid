#!/usr/bin/env node
/**
 * Run a turbo task and report what the cache actually did (#892 Phase 0).
 *
 * THE QUESTION THIS EXISTS TO ANSWER. `bun run build` measured ~4.5 minutes in
 * five separate CI lanes, four of which pass `turbo-cache: "true"`. Nobody could
 * say why, because turbo's default output says `cache miss, executing <hash>`
 * per task and nothing about WHY the hash moved or whether the remote was even
 * reachable — and a lane that silently degrades to "no remote cache" looks
 * exactly like a lane whose inputs genuinely changed. Five lanes pay that per
 * run; one investigation should settle it, and an investigation needs numbers.
 *
 * WHAT IT PRINTS. `--summarize` makes turbo write a run summary to
 * `.turbo/runs/<id>.json`; this reads the newest one and reports:
 *
 *   - per task: `hit (local)` / `hit (remote)` / `MISS`, plus duration
 *   - the aggregate hit rate and the wall time spent inside misses
 *   - the GLOBAL hash inputs, because a global-hash change invalidates every
 *     task at once and is the single most common cause of a whole-graph miss —
 *     it is also the one thing per-task output can never show you
 *
 * The table goes to `$GITHUB_STEP_SUMMARY` when it exists, so the answer is on
 * the run page rather than buried in a log fold.
 *
 * IT DOES NOT GATE. `--min-hit-rate` exists and is deliberately unused by any
 * lane: there is no measured baseline yet, and a threshold invented before the
 * first measurement is the kind of number this repo's budgets are supposed to be
 * the opposite of. Seed it from real runs, then ratchet.
 *
 * Usage:
 *   node scripts/ci/turbo-cache-report.ts --task build [-- <extra turbo args>]
 *   node scripts/ci/turbo-cache-report.ts --report-only
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { turboEnv } from "./turbo.ts";

const root = path.resolve(import.meta.dirname, "../..");
const RUNS_DIR = path.join(root, ".turbo/runs");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CacheStatus = "hit" | "miss" | "unknown";

export interface CacheClassification {
  status: CacheStatus;
  source: string;
}

export interface TaskRow {
  task: string;
  status: CacheStatus;
  source: string;
  durationMs: number;
}

export interface CacheSummary {
  rows: TaskRow[];
  total: number;
  hits: number;
  misses: number;
  unknown: number;
  hitRate: number;
  missMs: number;
}

/**
 * Classify one summary task entry.
 *
 * Turbo's summary shape has moved across majors (`cache.status`/`cache.source`
 * in 2.x, a bare `cacheState` before it), so read defensively and report
 * `unknown` rather than silently counting an unrecognised shape as a hit — a
 * cache report that rounds toward "it worked" is worse than none.
 */
export function classifyTask(task: unknown): CacheClassification {
  if (!isRecord(task)) return { status: "unknown", source: "-" };
  const cacheState = isRecord(task.cacheState) ? task.cacheState.local : null;
  const cache = task.cache ?? cacheState ?? null;
  if (isRecord(cache)) {
    const local = cache.local === true;
    const remote = cache.remote === true;
    if (cache.status === "HIT" || local || remote) {
      return { status: "hit", source: remote ? "remote" : "local" };
    }
    if (cache.status === "MISS" || cache.status === "MISSING") {
      return { status: "miss", source: "-" };
    }
  }
  return { status: "unknown", source: "-" };
}

/**
 * How long a task's execution took.
 *
 * turbo 2.x records `startTime`/`endTime` epoch millis; older summaries carried
 * a `duration`. Read both, and fall back to 0 rather than NaN so one unfamiliar
 * entry cannot poison the aggregate.
 */
export function taskDurationMs(execution: unknown): number {
  if (!isRecord(execution)) return 0;
  if (
    typeof execution.duration === "number" &&
    Number.isFinite(execution.duration)
  ) {
    return execution.duration;
  }
  const start = Number(execution.startTime);
  const end = Number(execution.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start;
  }
  return 0;
}

/** Summarize a turbo run summary object into rows plus totals. */
export function summarize(summary: unknown): CacheSummary {
  const tasks =
    isRecord(summary) && Array.isArray(summary.tasks) ? summary.tasks : [];
  const rows = tasks.map((task) => {
    const { status, source } = classifyTask(task);
    const record = isRecord(task) ? task : {};
    return {
      task: `${record.package ?? "<root>"}#${record.task ?? "?"}`,
      status,
      source,
      durationMs: taskDurationMs(record.execution),
    };
  });
  const hits = rows.filter((r) => r.status === "hit").length;
  const misses = rows.filter((r) => r.status === "miss");
  const unknown = rows.filter((r) => r.status === "unknown").length;
  return {
    rows,
    total: rows.length,
    hits,
    misses: misses.length,
    unknown,
    // Hit rate over CLASSIFIED tasks only, and `unknown` reported beside it, so
    // an unreadable summary shape cannot inflate the number.
    hitRate: rows.length - unknown > 0 ? hits / (rows.length - unknown) : 0,
    missMs: misses.reduce((sum, r) => sum + r.durationMs, 0),
  };
}

/** Markdown for the Job Summary. */
export function renderReport(
  result: CacheSummary,
  globalHashInputs: unknown
): string {
  const pct = (result.hitRate * 100).toFixed(1);
  const lines = [
    "### Turbo cache",
    "",
    `**${result.hits}/${result.total - result.unknown} tasks cached (${pct}%)** — ` +
      `${Math.round(result.missMs / 1000)}s spent executing misses` +
      (result.unknown
        ? `; ${result.unknown} task(s) in an unrecognised summary shape`
        : ""),
    "",
    "| Task | Cache | Source | Duration |",
    "| --- | --- | --- | ---: |",
  ];
  for (const row of result.rows) {
    lines.push(
      `| \`${row.task}\` | ${row.status === "hit" ? "hit" : row.status.toUpperCase()} | ${row.source} | ${Math.round(row.durationMs / 1000)}s |`
    );
  }
  if (globalHashInputs) {
    lines.push(
      "",
      "<details><summary>Global hash inputs — a change here misses EVERY task at once</summary>",
      "",
      "```json",
      JSON.stringify(globalHashInputs, null, 2),
      "```",
      "",
      "</details>"
    );
  }
  return lines.join("\n");
}

function newestSummary(): unknown {
  if (!existsSync(RUNS_DIR)) return null;
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(RUNS_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = files[0];
  if (newest === undefined) return null;
  const parsed: unknown = JSON.parse(readFileSync(newest, "utf8"));
  return parsed;
}

function parseArgs(argv: string[]): {
  task: string | null;
  minHitRate: number | null;
  reportOnly: boolean;
  passthrough: string[];
} {
  const out: {
    task: string | null;
    minHitRate: number | null;
    reportOnly: boolean;
    passthrough: string[];
  } = {
    task: null,
    minHitRate: null,
    reportOnly: false,
    passthrough: [],
  };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) out.passthrough = argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    const current = own[i];
    const next = own[i + 1];
    if (current === "--task" && next !== undefined) {
      out.task = next;
      i += 1;
    } else if (current === "--min-hit-rate" && next !== undefined) {
      out.minHitRate = Number(next);
      i += 1;
    } else if (current === "--report-only") {
      out.reportOnly = true;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task && !args.reportOnly) {
    console.error("turbo-cache-report: --task <name> is required");
    process.exitCode = 2;
    return;
  }

  let taskStatus = 0;
  if (!args.reportOnly) {
    const result = spawnSync(
      path.join(root, "node_modules/.bin/turbo"),
      ["run", args.task ?? "", "--summarize", ...args.passthrough],
      { cwd: root, env: turboEnv(), stdio: "inherit" }
    );
    taskStatus = result.status ?? 1;
  }

  const summary = newestSummary();
  if (!summary) {
    // The build's own exit status still governs; a missing summary is a
    // reporting gap, not a build failure, and saying so beats pretending the
    // cache was measured.
    console.warn(
      "::warning title=Turbo cache unmeasured::no .turbo/runs summary was written; cache behaviour was not measured this run"
    );
    process.exitCode = taskStatus;
    return;
  }

  const result = summarize(summary);
  const globalHashInputs = isRecord(summary)
    ? summary.globalCacheInputs
    : undefined;
  const report = renderReport(result, globalHashInputs);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  if (
    taskStatus === 0 &&
    args.minHitRate != null &&
    result.hitRate < args.minHitRate
  ) {
    console.error(
      `::error title=Turbo cache below floor::hit rate ${(result.hitRate * 100).toFixed(1)}% < ${(args.minHitRate * 100).toFixed(1)}%`
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = taskStatus;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
