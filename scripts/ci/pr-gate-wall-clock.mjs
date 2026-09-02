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
 * WHAT IT MEASURES. The PR gate's wall clock is `max(completed_at) −
 * min(started_at)` across the jobs in `check`'s `needs:` list. Not the sum:
 * those jobs run in parallel and the sum would punish parallelism, which is the
 * one thing that makes the gate fast. Not `check`'s own duration either: it
 * starts last and would report five seconds. The span is what a human sits
 * through, so the span is what is budgeted.
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
 * Elapsed wall clock across the gate.
 *
 * @param {{name: string, started_at?: string, completed_at?: string}[]} jobs Gate jobs.
 * @returns {{ms: number, firstStart: string, lastEnd: string, slowest: {name: string, ms: number}|null}|null} Null when nothing measurable ran.
 */
export function wallClockMs(jobs) {
  if (!jobs.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let slowest = null;
  for (const job of jobs) {
    const start = Date.parse(job.started_at ?? "");
    const end = Date.parse(job.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < min) min = start;
    if (end > max) max = end;
    const span = end - start;
    if (!slowest || span > slowest.ms) slowest = { name: job.name, ms: span };
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return {
    ms: max - min,
    firstStart: new Date(min).toISOString(),
    lastEnd: new Date(max).toISOString(),
    slowest,
  };
}

const fmt = (ms) => `${(ms / 60000).toFixed(1)} min`;

/**
 * Markdown for the Job Summary.
 *
 * @param {{ms: number, slowest: {name: string, ms: number}|null}} measured What the run took.
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
    "",
    "This is the span a person waits, not the sum of the lanes — the sum would punish the parallelism that makes the gate fast. Over budget, the fix is to move a lane to rung 3 or make it faster, never to widen the ceiling: `tests/suite-wall-clock.json` is tighten-only.",
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
      `::error title=PR gate over budget::the rung-2 gate took ${fmt(measured.ms)} against a ${fmt(budgetMs)} ceiling. Move a lane to rung 3 (candidate.yml) or make it faster; tests/suite-wall-clock.json only tightens.`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
