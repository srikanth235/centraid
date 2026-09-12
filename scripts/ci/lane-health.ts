#!/usr/bin/env node
/**
 * Per-lane first-attempt pass rate, and the chronic-red rule (#892 Phase 3).
 *
 * TWO DECISIONS THIS REPO MAKES ON MEMORY, MADE ON EVIDENCE INSTEAD.
 *
 * 1. PROMOTION AND DEMOTION. `lane-client-e2e.yml` records the rule — "if a
 *    nightly-only area burns us twice, move it here" — and nothing counts the
 *    burns. The inverse is worse and unwritten: a REQUIRED lane that fails its
 *    first attempt on clean code teaches people to press re-run, and a re-run
 *    habit devalues all nineteen lanes at once. A required lane below ~95%
 *    first-attempt pass costs more confidence than it buys, and until now
 *    nobody could say which lanes those were. The perf gate already shows the
 *    right shape — it annotates its retry instead of absorbing it — and this is
 *    that shape applied to the whole matrix.
 *
 * 2. CHRONIC RED. A required lane red on `main` for days is the state in which
 *    "merge past the red" becomes normal. The quarantine ledger already handles
 *    this for TESTS (declared, attributed, expiring); lanes had no equivalent,
 *    so a long-red lane simply stayed red. `--chronic-red-days N` fails, and
 *    files a deduplicated tracking issue, when a lane has been red on main for
 *    longer than N days without an unexpired entry in tests/quarantine.json#lanes.
 *
 * Nightly-only, deliberately: it reads api.github.com, and the PR lane must not
 * acquire a dependency on it (the same rule test:citations follows).
 *
 * 3. THE RULES TABLE (#915). Pass rate, escapes, consecutive reds, expired
 *    parks and p95-over-budget are now decided mechanically by
 *    `scripts/ci/lane-rules.ts` and written to the summary as `findings`, each`
 *    carrying the rolling issue title the workflow should open or update. The
 *    report-level `verdict` (`HOLD` / `OK`) over the parks ledger is written
 *    beside them, so the nightly page and this lane can never disagree about
 *    how much debt the ladder is carrying.
 *
 * Usage:
 *   node scripts/ci/lane-health.ts --repo owner/name [--workflow ci.yml]
 *        [--rung 2] [--escape-workflow ci.yml]
 *        [--runs 40] [--chronic-red-days 3] [--out artifacts/lane-health/summary.json]
 */
import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  RUNG_BUDGET_MS,
  WORKFLOW_RUNG,
  applyLaneRules,
  countEscapes,
  greenShas,
  laneDurations,
  overallVerdict,
  percentile,
} from "./lane-rules.ts";
import type {
  LaneFinding,
  LaneJob,
  ParkEntry,
  RateEntry,
  StreakEntry,
} from "./lane-rules.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HealthRun {
  runAttempt: number;
  startedAt: string;
  headSha?: string;
  jobs: LaneJob[];
}

const root = path.resolve(import.meta.dirname, "../..");
// Lane parks merged into the quarantine ledger beside the flaky-test entries
// in #915 Wave 4; the shape (`lanes: {lane: {issue, expires, why}}`) is unchanged.
const QUARANTINE_PATH = path.join(root, "tests/quarantine.json");

/**
 * First-attempt pass rate per job name.
 *
 * ONLY `run_attempt === 1` counts. That is the whole measurement: a lane that is
 * green on the third try is a lane somebody re-ran twice, and counting the
 * eventual conclusion would report exactly the health this is meant to expose as
 * false. `skipped` is excluded from the denominator — a path-gated lane the diff
 * did not touch has no opinion about its own health.
 *
 * @param {{runAttempt: number, jobs: {name: string, conclusion: string}[]}[]} runs completed workflow runs on main
 * @returns {Map<string, {attempts: number, passed: number, rate: number}>} per-lane first-attempt tally and rate
 */
export function firstAttemptRates(
  runs: readonly HealthRun[]
): Map<string, RateEntry> {
  const tally = new Map<string, RateEntry>();
  for (const run of runs) {
    if (run.runAttempt !== 1) continue;
    for (const job of run.jobs) {
      if (job.conclusion === "skipped" || job.conclusion == null) continue;
      const entry = tally.get(job.name) ?? { attempts: 0, passed: 0, rate: 0 };
      entry.attempts += 1;
      if (job.conclusion === "success") entry.passed += 1;
      tally.set(job.name, entry);
    }
  }
  for (const entry of tally.values()) {
    entry.rate = entry.attempts === 0 ? 0 : entry.passed / entry.attempts;
  }
  return tally;
}

/**
 * How long each job has been continuously non-green on main.
 *
 * Walks runs NEWEST FIRST and stops a lane's streak at its first success. A lane
 * whose most recent run is green has no streak, however bad last week was —
 * chronic red is about the present, and the pass-rate half above is where
 * history lives.
 *
 * @param {{startedAt: string, runAttempt: number, jobs: {name: string, conclusion: string}[]}[]} runsNewestFirst completed runs, newest first
 * @param {string} now ISO timestamp to measure the streak against
 * @returns {Map<string, {since: string, days: number, runs: number}>} per-lane current red streak
 */
export function redStreaks(
  runsNewestFirst: readonly HealthRun[],
  now: string
): Map<string, StreakEntry> {
  const streaks = new Map<string, StreakEntry>();
  const settled = new Set<string>();
  for (const run of runsNewestFirst) {
    for (const job of run.jobs) {
      if (settled.has(job.name)) continue;
      if (job.conclusion === "skipped" || job.conclusion == null) continue;
      if (job.conclusion === "success") {
        settled.add(job.name);
        continue;
      }
      const entry = streaks.get(job.name) ?? {
        since: run.startedAt,
        days: 0,
        runs: 0,
      };
      // Runs arrive newest first, so each further red run pushes `since` back.
      entry.since = run.startedAt;
      entry.runs += 1;
      streaks.set(job.name, entry);
    }
  }
  const nowMs = Date.parse(now);
  for (const entry of streaks.values()) {
    entry.days = Math.max(
      0,
      Math.round(((nowMs - Date.parse(entry.since)) / 86_400_000) * 10) / 10
    );
  }
  return streaks;
}

/**
 * Lanes that have been red longer than the rule allows and are not quarantined.
 *
 * @param {Map<string, {since: string, days: number, runs: number}>} streaks current red streaks, from `redStreaks`
 * @param {Record<string, {issue?: string, expires?: string, why?: string}>} quarantine the `lanes` map from tests/quarantine.json
 * @param {number} maxDays how many days a lane may stay red before the rule fires
 * @param {string} today ISO date, to judge whether a park has expired
 * @returns {{lane: string, days: number, runs: number, since: string, reason: string}[]} lanes past the rule, worst first
 */
export function chronicRed(
  streaks: Map<string, StreakEntry>,
  quarantine: Record<string, ParkEntry | undefined>,
  maxDays: number,
  today: string
): {
  lane: string;
  days: number;
  runs: number;
  since: string;
  reason: string;
}[] {
  const offenders: {
    lane: string;
    days: number;
    runs: number;
    since: string;
    reason: string;
  }[] = [];
  for (const [lane, streak] of streaks) {
    if (streak.days <= maxDays) continue;
    const parked = quarantine[lane];
    if (parked && parked.expires && parked.expires >= today) continue;
    offenders.push({
      lane,
      days: streak.days,
      runs: streak.runs,
      since: streak.since,
      reason:
        parked && parked.expires && parked.expires < today
          ? `quarantined until ${parked.expires}, which has passed`
          : "not quarantined",
    });
  }
  return offenders.sort((left, right) => right.days - left.days);
}

/** Markdown for the Job Summary. */
export function renderLaneHealth(
  rates: Map<string, RateEntry>,
  streaks: Map<string, StreakEntry>,
  floor: number
): string {
  const rows = [...rates.entries()].sort(
    (left, right) => left[1].rate - right[1].rate
  );
  const lines = [
    "### Lane health (first attempt, `main`)",
    "",
    "| Lane | First-attempt pass | Runs | Red streak |",
    "| --- | ---: | ---: | --- |",
  ];
  for (const [lane, entry] of rows) {
    const streak = streaks.get(lane);
    const pct = (entry.rate * 100).toFixed(0);
    const flag = entry.rate < floor ? " ⚠️" : "";
    lines.push(
      `| \`${lane}\` | ${pct}%${flag} | ${entry.attempts} | ${streak ? `${streak.days}d (${streak.runs} runs)` : "—"} |`
    );
  }
  lines.push(
    "",
    `⚠️ marks a lane below ${(floor * 100).toFixed(0)}% first-attempt pass. A required lane there costs more confidence than it buys: it teaches people to press re-run, and a re-run habit devalues every other lane at the same time.`
  );
  return lines.join("\n");
}

/**
 * Markdown for the rules table's findings.
 *
 * @param {{lane: string, kind: string, title: string, detail: string}[]} findings From `applyLaneRules`.
 * @param {{verdict: string, reasons: string[]}} verdict From `overallVerdict`.
 * @param {number|null} rung Which rung was scored.
 * @returns {string} Markdown.
 */
export function renderFindings(
  findings: readonly LaneFinding[],
  verdict: { verdict: string; reasons: string[] },
  rung: number | null
): string {
  const lines = [
    `### Lane rules (rung ${rung ?? "?"}) — verdict ${verdict.verdict}`,
    "",
  ];
  if (verdict.reasons.length) {
    for (const reason of verdict.reasons) lines.push(`- HOLD: ${reason}`);
    lines.push("");
  }
  if (!findings.length) {
    lines.push(
      "No rule fired: every lane is inside its budget, its pass rate and its park."
    );
    return lines.join("\n");
  }
  lines.push("| Lane | Rule | What to do |", "| --- | --- | --- |");
  for (const finding of findings) {
    lines.push(`| \`${finding.lane}\` | ${finding.kind} | ${finding.detail} |`);
  }
  return lines.join("\n");
}

// --- fetching ---------------------------------------------------------------

async function gh(url: string, token: string | undefined): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${url} → ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchRuns(
  repo: string,
  workflow: string,
  limit: number,
  token: string | undefined
): Promise<HealthRun[]> {
  const list = await gh(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=${Math.min(limit, 100)}`,
    token
  );
  const workflowRuns =
    isRecord(list) && Array.isArray(list.workflow_runs)
      ? list.workflow_runs
      : [];
  // Fetched concurrently: 40 sequential round trips is a minute of nothing, and
  // the jobs endpoint is per-run so there is no ordering between them.
  return Promise.all(
    workflowRuns.map(async (runRaw) => {
      const run = isRecord(runRaw) ? runRaw : {};
      const jobsRaw = await gh(
        `https://api.github.com/repos/${repo}/actions/runs/${String(run.id)}/jobs?per_page=100`,
        token
      );
      const jobsList =
        isRecord(jobsRaw) && Array.isArray(jobsRaw.jobs) ? jobsRaw.jobs : [];
      return {
        id: run.id,
        headSha: String(run.head_sha ?? ""),
        runAttempt: typeof run.run_attempt === "number" ? run.run_attempt : 1,
        startedAt: String(run.run_started_at ?? run.created_at ?? ""),
        jobs: jobsList.map((jobRaw) => {
          const job = isRecord(jobRaw) ? jobRaw : {};
          return {
            name: String(job.name ?? ""),
            conclusion:
              typeof job.conclusion === "string" ? job.conclusion : null,
            startedAt:
              typeof job.started_at === "string" ? job.started_at : undefined,
            completedAt:
              typeof job.completed_at === "string"
                ? job.completed_at
                : undefined,
          };
        }),
      };
    })
  );
}

function parseArgs(argv: string[]): {
  repo: string | null;
  workflow: string;
  runs: number;
  chronicRedDays: number | null;
  floor: number;
  out: string | null;
  rung: number | null;
  escapeWorkflow: string | null;
} {
  const out: {
    repo: string | null;
    workflow: string;
    runs: number;
    chronicRedDays: number | null;
    floor: number;
    out: string | null;
    rung: number | null;
    escapeWorkflow: string | null;
  } = {
    repo: process.env.GITHUB_REPOSITORY ?? null,
    workflow: "ci.yml",
    runs: 40,
    chronicRedDays: null,
    floor: 0.95,
    out: null,
    rung: null,
    escapeWorkflow: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--repo" && next !== undefined) {
      out.repo = next;
      i += 1;
    } else if (current === "--workflow" && next !== undefined) {
      out.workflow = next;
      i += 1;
    } else if (current === "--runs" && next !== undefined) {
      out.runs = Number(next);
      i += 1;
    } else if (current === "--chronic-red-days" && next !== undefined) {
      out.chronicRedDays = Number(next);
      i += 1;
    } else if (current === "--floor" && next !== undefined) {
      out.floor = Number(next);
      i += 1;
    } else if (current === "--out" && next !== undefined) {
      out.out = next;
      i += 1;
    } else if (current === "--rung" && next !== undefined) {
      out.rung = Number(next);
      i += 1;
    } else if (current === "--escape-workflow" && next !== undefined) {
      out.escapeWorkflow = next;
      i += 1;
    }
  }
  // A workflow this repo knows about implies its rung; an unknown one must say.
  if (out.rung == null) out.rung = WORKFLOW_RUNG[out.workflow] ?? null;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo) {
    console.error("lane-health: --repo owner/name is required");
    process.exitCode = 2;
    return;
  }
  const runs = await fetchRuns(
    args.repo,
    args.workflow,
    args.runs,
    process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  );
  const rates = firstAttemptRates(runs);
  const streaks = redStreaks(runs, new Date().toISOString());
  const report = renderLaneHealth(rates, streaks, args.floor);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  const quarantineRaw: unknown = existsSync(QUARANTINE_PATH)
    ? JSON.parse(readFileSync(QUARANTINE_PATH, "utf8"))
    : {};
  const quarantine: Record<string, ParkEntry | undefined> =
    isRecord(quarantineRaw) && isRecord(quarantineRaw.lanes)
      ? (quarantineRaw.lanes as Record<string, ParkEntry | undefined>)
      : {};
  const today = new Date().toISOString().slice(0, 10);

  // Escapes need BOTH sides: what the deep rung caught, and which SHAs the
  // merge gate had already called green. Skipped when the caller does not name
  // a rung-2 workflow, because an escape count computed from one workflow is
  // not an approximation of the rule — it is a different number wearing its
  // name.
  let escapes = new Map();
  if (args.escapeWorkflow && args.escapeWorkflow !== args.workflow) {
    try {
      const gateRuns = await fetchRuns(
        args.repo,
        args.escapeWorkflow,
        args.runs,
        process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
      );
      escapes = countEscapes(runs, greenShas(gateRuns));
    } catch (error) {
      console.error(
        `::warning title=Escapes unmeasured::could not read ${args.escapeWorkflow} runs (${error instanceof Error ? error.message : String(error)}); the escape column is empty this run rather than zero`
      );
    }
  }

  const durations = laneDurations(runs);
  const findings =
    args.rung == null
      ? []
      : applyLaneRules({
          rates,
          streaks,
          durations,
          escapes,
          quarantine,
          rung: args.rung,
          today,
        });
  const verdict = overallVerdict(quarantine, today);
  const rulesReport = renderFindings(findings, verdict, args.rung);
  console.log(rulesReport);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rulesReport}\n`);
  }

  if (args.out) {
    mkdirSync(path.dirname(path.resolve(root, args.out)), { recursive: true });
    writeFileSync(
      path.resolve(root, args.out),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          workflow: args.workflow,
          rung: args.rung,
          rungBudgetMs: args.rung == null ? null : RUNG_BUDGET_MS[args.rung],
          floor: args.floor,
          verdict: verdict.verdict,
          reasons: verdict.reasons,
          lanes: Object.fromEntries(rates),
          redStreaks: Object.fromEntries(streaks),
          escapes: Object.fromEntries(escapes),
          p95Ms: Object.fromEntries(
            [...durations].map(([lane, samples]) => [
              lane,
              percentile(samples, 0.95),
            ])
          ),
          findings,
        },
        null,
        2
      )}\n`
    );
  }

  // A finding whose action is "open an issue" does not red this lane — the
  // demote and promote rules are advice with a deadline attached, and reding
  // the nightly for them would make the nightly mean less, which is the whole
  // disease #915 is treating. The three that ARE red are the ones the ladder
  // says are red: an expired park, a lane over its rung's budget, and a lane
  // that owes a park it has not been given.
  const redKinds = new Set(["park-expired", "over-budget", "park-required"]);
  const red = findings.filter((finding) => redKinds.has(finding.kind));
  for (const finding of red) {
    console.error(
      `::error title=${finding.title}::\`${finding.lane}\` — ${finding.detail}`
    );
  }
  if (red.length > 0) process.exitCode = 1;

  if (args.chronicRedDays == null) return;
  const offenders = chronicRed(streaks, quarantine, args.chronicRedDays, today);
  if (offenders.length === 0) {
    console.log(
      `lane-health: no lane has been red on main for more than ${args.chronicRedDays} day(s)`
    );
    return;
  }
  for (const offender of offenders) {
    console.error(
      `::error title=Chronic red lane::\`${offender.lane}\` has been red on main for ${offender.days} day(s) across ${offender.runs} run(s) (${offender.reason}). Fix it, or quarantine it WITH AN EXPIRY in tests/quarantine.json#lanes — a required lane that stays red teaches merging past red, which devalues every other lane.`
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
