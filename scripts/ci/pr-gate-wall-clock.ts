#!/usr/bin/env node
/**
 * The rung-2 budget, measured and enforced on the run that spent it (#915).
 *
 * WHAT WAS MISSING. `tests/budgets.json#suiteWallClock` fenced the vitest suite's
 * summed file spans, which is the right backpressure on ADDING TESTS and says
 * nothing about the thing a person actually waits for: the elapsed minutes
 * between pushing and `check` going green. #915 measured that at ~26 minutes
 * against a docs claim of 12.3, and nothing in the repo could have noticed —
 * a budget nobody measures is a wish.
 *
 * WHAT IT MEASURES. The union of the `started_at → completed_at` intervals of
 * the jobs in `check`'s `needs:` list — the time during which at least one gate
 * lane was running. Not the sum: those jobs run in parallel and the sum would
 * punish parallelism, which is the one thing that makes the gate fast. Not
 * `check`'s own duration either: it starts last and would report five seconds.
 * And, since #931, not the raw `max(completed_at) − min(started_at)` span
 * either: that charged the PR for the runner queue between one lane finishing
 * and the next starting, which no diff can make shorter. The span is still
 * reported beside the budgeted number, because the gap between them is the
 * backlog and someone should be able to see it.
 *
 * The lane list is read from `ci.yml` itself rather than restated here, because
 * a second hand-maintained copy of `check.needs` is exactly the failure mode
 * #557's nightly-failure-issue demonstrated.
 *
 * Usage (inside the `check` job, which needs `actions: read`):
 *   node scripts/ci/pr-gate-wall-clock.ts --repo owner/name --run-id 123
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const CI_PATH = path.join(root, ".github/workflows/ci.yml");
const BUDGET_PATH = path.join(root, "tests/budgets.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GateJob {
  name: string;
  started_at?: string;
  completed_at?: string;
  conclusion?: string;
}

export interface WallClock {
  ms: number;
  spanMs: number;
  queuedMs: number;
  firstStart: string;
  lastEnd: string;
  slowest: { name: string; ms: number } | null;
}

/** The job ids in `check`'s `needs:` list. */
export function parseCheckNeeds(yaml: string): string[] {
  const start = yaml.indexOf("\n  check:");
  if (start === -1) return [];
  const needsAt = yaml.indexOf("needs:", start);
  if (needsAt === -1) return [];
  const open = yaml.indexOf("[", needsAt);
  const close = yaml.indexOf("]", open);
  if (open === -1 || close === -1) return [];
  return yaml
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/#.*$/u, ""))
    .join(",")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z0-9_-]+$/u.test(token));
}

function asJob(value: unknown): GateJob | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return {
    name: value.name,
    started_at:
      typeof value.started_at === "string" ? value.started_at : undefined,
    completed_at:
      typeof value.completed_at === "string" ? value.completed_at : undefined,
    conclusion:
      typeof value.conclusion === "string" ? value.conclusion : undefined,
  };
}

/** Parse the newline-delimited JSON `gh api --jq '.jobs[]' --paginate` emits. */
export function parseJobsStream(stdout: string | null | undefined): GateJob[] {
  const jobs: GateJob[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const job = asJob(item);
          if (job) jobs.push(job);
        }
      } else {
        const job = asJob(parsed);
        if (job) jobs.push(job);
      }
    } catch {
      // A single unparseable line must not lose the rest of the page.
    }
  }
  return jobs;
}

/** The jobs belonging to the gate. */
export function selectGateJobs(
  jobs: readonly GateJob[],
  needs: readonly string[]
): GateJob[] {
  const wanted = new Set(needs.filter((id) => id !== "check"));
  return jobs.filter((job) => {
    if (job.conclusion === "skipped") return false;
    if (!job.started_at || !job.completed_at) return false;
    const bare = job.name.replace(/\s*\(.*\)\s*$/u, "");
    return wanted.has(job.name) || wanted.has(bare);
  });
}

/** The gate's WORK, and the span it sat inside. */
export function wallClockMs(jobs: readonly GateJob[]): WallClock | null {
  if (!jobs.length) return null;
  const intervals: [number, number][] = [];
  let slowest: { name: string; ms: number } | null = null;
  for (const job of jobs) {
    const start = Date.parse(job.started_at ?? "");
    const end = Date.parse(job.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    intervals.push([start, Math.max(start, end)]);
    const span = end - start;
    if (!slowest || span > slowest.ms) slowest = { name: job.name, ms: span };
  }
  const first = intervals[0];
  if (first === undefined) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let openStart = first[0];
  let openEnd = first[1];
  const head = intervals[0];
  if (head === undefined) return null;
  openStart = head[0];
  openEnd = head[1];
  for (const [start, end] of intervals.slice(1)) {
    if (start > openEnd) {
      busy += openEnd - openStart;
      openStart = start;
      openEnd = end;
    } else if (end > openEnd) {
      openEnd = end;
    }
  }
  busy += openEnd - openStart;
  const min = head[0];
  const max = Math.max(...intervals.map(([, end]) => end));
  return {
    ms: busy,
    spanMs: max - min,
    queuedMs: max - min - busy,
    firstStart: new Date(min).toISOString(),
    lastEnd: new Date(max).toISOString(),
    slowest,
  };
}

const fmt = (ms: number): string => `${(ms / 60000).toFixed(1)} min`;

/** Markdown for the Job Summary. */
export function renderWallClock(
  measured: {
    ms: number;
    spanMs?: number;
    queuedMs?: number;
    slowest: { name: string; ms: number } | null;
  },
  budgetMs: number,
  lanes: number
): string {
  const over = measured.ms > budgetMs;
  return [
    "### PR gate wall clock (rung 2)",
    "",
    `**${fmt(measured.ms)} of the ${fmt(budgetMs)} budget** across ${lanes} lane(s)${over ? " — OVER" : ""}.`,
    "",
    measured.slowest
      ? `Longest single lane: \`${measured.slowest.name}\` at ${fmt(measured.slowest.ms)}.`
      : "",
    typeof measured.queuedMs === "number" && typeof measured.spanMs === "number"
      ? `Elapsed from first start to last finish: ${fmt(measured.spanMs)}, of which ${fmt(measured.queuedMs)} was runner queue with no gate job running.`
      : "",
    "",
    "This is the union of the lanes' busy intervals, not their sum and not the raw elapsed span. The sum would punish the parallelism that makes the gate fast; the raw span charged the PR for the account's runner backlog (#931). Over budget, the fix is to move a lane to rung 3 or make it faster, never to widen the ceiling: `tests/budgets.json#suiteWallClock` is tighten-only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function parseArgs(argv: string[]): {
  repo: string | null;
  runId: string | null;
  lane: string;
} {
  const out: { repo: string | null; runId: string | null; lane: string } = {
    repo: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    lane: "pr-gate",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--repo" && next !== undefined) {
      out.repo = next;
      i += 1;
    } else if (current === "--run-id" && next !== undefined) {
      out.runId = next;
      i += 1;
    } else if (current === "--lane" && next !== undefined) {
      out.lane = next;
      i += 1;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.runId) {
    console.error(
      "pr-gate-wall-clock: --repo owner/name and --run-id are required"
    );
    process.exitCode = 2;
    return;
  }
  const budgetsRaw: unknown = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
  const suite =
    isRecord(budgetsRaw) && isRecord(budgetsRaw.suiteWallClock)
      ? budgetsRaw.suiteWallClock
      : {};
  const lanes = isRecord(suite.lanes) ? suite.lanes : {};
  const lane = isRecord(lanes[args.lane]) ? lanes[args.lane] : {};
  const budgetMs = Number(isRecord(lane) ? lane.budgetMs : undefined);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    console.error(
      `pr-gate-wall-clock: tests/budgets.json#suiteWallClock has no positive lanes["${args.lane}"].budgetMs`
    );
    process.exitCode = 1;
    return;
  }

  const listed = spawnSync(
    "gh",
    [
      "api",
      `repos/${args.repo}/actions/runs/${args.runId}/jobs?per_page=100`,
      "--paginate",
      "--jq",
      ".jobs[] | {name, started_at, completed_at, conclusion}",
    ],
    { encoding: "utf8" }
  );
  if (listed.status !== 0) {
    console.error(
      `::error title=PR gate wall clock unmeasured::could not read this run's jobs (${(listed.stderr ?? "").trim()}). The \`check\` job needs \`actions: read\`.`
    );
    process.exitCode = 1;
    return;
  }

  const needs = parseCheckNeeds(readFileSync(CI_PATH, "utf8"));
  const gateJobs = selectGateJobs(parseJobsStream(listed.stdout), needs);
  const measured = wallClockMs(gateJobs);
  if (!measured) {
    console.log(
      "pr-gate-wall-clock: no gate lane reported a start and end — nothing to measure"
    );
    return;
  }

  const report = renderWallClock(measured, budgetMs, gateJobs.length);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
  if (measured.ms > budgetMs) {
    console.error(
      `::error title=PR gate over budget::the rung-2 gate spent ${fmt(measured.ms)} of runner time against a ${fmt(budgetMs)} ceiling (queue wait excluded). Move a lane to rung 3 (candidate.yml) or make it faster; tests/budgets.json#suiteWallClock only tightens.`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
