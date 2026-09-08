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
 *   node scripts/ci/pr-gate-wall-clock.mjs --repo owner/name --run-id 123
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const CI_PATH = path.join(root, ".github/workflows/ci.yml");
// The wall-clock ceilings are `tests/budgets.json#suiteWallClock` (#915 Wave 4).
const BUDGET_PATH = path.join(root, "tests/budgets.json");

/**
 * The job ids in `check`'s `needs:` list.
 *
 * Parsed from the workflow text: `check:` is a top-level job (two spaces), its
 * `needs: [` block runs until the closing bracket, and every bare identifier in
 * between is a lane. Comments inside the list are stripped first — the real
 * list carries several, and they name lanes.
 *
 * @param {string} yaml The contents of `.github/workflows/ci.yml`.
 * @returns {string[]} Lane job ids, in declaration order.
 */
export function parseCheckNeeds(yaml) {
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

/**
 * Parse the newline-delimited JSON `gh api --jq '.jobs[]' --paginate` emits.
 *
 * @param {string} stdout Raw stdout.
 * @returns {{name: string, started_at: string, completed_at: string, conclusion: string}[]} Jobs.
 */
export function parseJobsStream(stdout) {
  const jobs = [];
  for (const line of (stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) jobs.push(...parsed);
      else jobs.push(parsed);
    } catch {
      // A single unparseable line must not lose the rest of the page.
    }
  }
  return jobs;
}

/**
 * The jobs belonging to the gate.
 *
 * A matrix leg's GitHub job name is `<id> (<leg>)`, so the match is "equals the
 * id, or starts with `<id> (`". Skipped jobs are excluded: a path-gated lane the
 * diff never woke contributes no minutes and would otherwise drag `started_at`
 * to the front of the run for nothing.
 *
 * @param {{name: string, conclusion: string, started_at?: string, completed_at?: string}[]} jobs Every job of the run.
 * @param {string[]} needs Lane ids from `check.needs`.
 * @returns {{name: string, started_at?: string, completed_at?: string}[]} The gate's jobs.
 */
export function selectGateJobs(jobs, needs) {
  const wanted = new Set(needs.filter((id) => id !== "check"));
  return jobs.filter((job) => {
    if (job.conclusion === "skipped") return false;
    if (!job.started_at || !job.completed_at) return false;
    const bare = job.name.replace(/\s*\(.*\)\s*$/u, "");
    return wanted.has(job.name) || wanted.has(bare);
  });
}

/**
 * The gate's WORK, and the span it sat inside.
 *
 * `ms` — the budgeted number — is the union of the jobs' `started_at →
 * completed_at` intervals: the time during which at least one gate job was
 * actually running on a runner. `spanMs` is the old `max(completed_at) −
 * min(started_at)`, kept for the summary because the difference between the two
 * IS the queue wait, and a reader deserves to see it.
 *
 * WHY IT CHANGED (#931 item 6). The span charged the PR for the account's
 * runner backlog. #937 touched `packages/core` only, every lane green, and
 * failed at 16.0 min against 15 because three workflows shared the pool and the
 * coverage shards queued: the gap between one lane finishing and the next
 * getting a runner is not work this gate can make faster, and it is not
 * something the author of the diff did. Two PRs in a row from one program hit
 * it, against a ladder whose own false-red target is ≤ 2 %. Pricing the union
 * of busy intervals still refuses to reward serialising the lanes — overlapping
 * work collapses into one interval exactly as it did before, so parallelism is
 * as valuable as ever — and it still charges every minute a runner spent on
 * this gate. What it stops charging is the minutes nobody spent on anything.
 *
 * The ceiling did NOT move: `tests/budgets.json` is untouched. This measures
 * the same 900,000 ms more honestly.
 *
 * @param {{name: string, started_at?: string, completed_at?: string}[]} jobs Gate jobs.
 * @returns {{ms: number, spanMs: number, queuedMs: number, firstStart: string, lastEnd: string, slowest: {name: string, ms: number}|null}|null} Null when nothing measurable ran.
 */
export function wallClockMs(jobs) {
  if (!jobs.length) return null;
  const intervals = [];
  let slowest = null;
  for (const job of jobs) {
    const start = Date.parse(job.started_at ?? "");
    const end = Date.parse(job.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    intervals.push([start, Math.max(start, end)]);
    const span = end - start;
    if (!slowest || span > slowest.ms) slowest = { name: job.name, ms: span };
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let [openStart, openEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start > openEnd) {
      // A gap in which no gate job was running at all: runner queue, not work.
      busy += openEnd - openStart;
      openStart = start;
      openEnd = end;
    } else if (end > openEnd) {
      openEnd = end;
    }
  }
  busy += openEnd - openStart;
  const min = intervals[0][0];
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

const fmt = (ms) => `${(ms / 60000).toFixed(1)} min`;

/**
 * Markdown for the Job Summary.
 *
 * @param {{ms: number, spanMs?: number, queuedMs?: number, slowest: {name: string, ms: number}|null}} measured What the run took.
 * @param {number} budgetMs The ceiling.
 * @param {number} lanes How many gate jobs were measured.
 * @returns {string} Markdown.
 */
export function renderWallClock(measured, budgetMs, lanes) {
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

function parseArgs(argv) {
  const out = {
    repo: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    lane: "pr-gate",
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo" && argv[i + 1]) out.repo = argv[++i];
    else if (argv[i] === "--run-id" && argv[i + 1]) out.runId = argv[++i];
    else if (argv[i] === "--lane" && argv[i + 1]) out.lane = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.runId) {
    console.error(
      "pr-gate-wall-clock: --repo owner/name and --run-id are required"
    );
    process.exitCode = 2;
    return;
  }
  const budgets = JSON.parse(readFileSync(BUDGET_PATH, "utf8")).suiteWallClock;
  const budgetMs = Number(budgets.lanes?.[args.lane]?.budgetMs);
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
    // Every lane skipped is a real state (a docs-only PR), and it is not a
    // budget breach. Say so rather than reporting a zero that reads as a win.
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
