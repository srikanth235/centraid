#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const RUNS_DIR = path.join(root, ".turbo/runs");

export function classifyTask(task) {
  const cache = task?.cache ?? task?.cacheState?.local ?? null;
  if (cache && typeof cache === "object") {
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

export function taskDurationMs(execution) {
  if (!execution || typeof execution !== "object") return 0;
  if (Number.isFinite(execution.duration)) return Number(execution.duration);
  const start = Number(execution.startTime);
  const end = Number(execution.endTime);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return end - start;
  }
  return 0;
}

export function summarize(summary) {
  const rows = (summary?.tasks ?? []).map((task) => {
    const { status, source } = classifyTask(task);
    return {
      task: `${task.package ?? "<root>"}#${task.task ?? "?"}`,
      status,
      source,
      durationMs: taskDurationMs(task?.execution),
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
    hitRate: rows.length - unknown > 0 ? hits / (rows.length - unknown) : 0,
    missMs: misses.reduce((sum, r) => sum + r.durationMs, 0),
  };
}

export function renderReport(result, globalHashInputs) {
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

function newestSummary() {
  if (!existsSync(RUNS_DIR)) return null;
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(RUNS_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) return null;
  return JSON.parse(readFileSync(files[0], "utf8"));
}

function parseArgs(argv) {
  const out = {
    task: null,
    minHitRate: null,
    reportOnly: false,
    passthrough: [],
  };
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  if (separator !== -1) out.passthrough = argv.slice(separator + 1);
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--task" && own[i + 1]) out.task = own[++i];
    else if (own[i] === "--min-hit-rate" && own[i + 1])
      out.minHitRate = Number(own[++i]);
    else if (own[i] === "--report-only") out.reportOnly = true;
  }
  return out;
}

function main() {
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
      ["run", args.task, "--summarize", ...args.passthrough],
      { cwd: root, stdio: "inherit" }
    );
    taskStatus = result.status ?? 1;
  }

  const summary = newestSummary();
  if (!summary) {
    console.warn(
      "::warning title=Turbo cache unmeasured::no .turbo/runs summary was written; cache behaviour was not measured this run"
    );
    process.exitCode = taskStatus;
    return;
  }

  const result = summarize(summary);
  const report = renderReport(result, summary.globalCacheInputs);
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
