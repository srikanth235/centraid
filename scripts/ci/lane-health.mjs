#!/usr/bin/env node
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
} from "./lane-rules.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const QUARANTINE_PATH = path.join(root, "tests/quarantine.json");

export function firstAttemptRates(runs) {
  const tally = new Map();
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

export function redStreaks(runsNewestFirst, now) {
  const streaks = new Map();
  const settled = new Set();
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

export function chronicRed(streaks, quarantine, maxDays, today) {
  const offenders = [];
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

export function renderLaneHealth(rates, streaks, floor) {
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

export function renderFindings(findings, verdict, rung) {
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

async function gh(url, token) {
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

async function fetchRuns(repo, workflow, limit, token) {
  const list = await gh(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=${Math.min(limit, 100)}`,
    token
  );
  return Promise.all(
    (list.workflow_runs ?? []).map(async (run) => {
      const jobs = await gh(
        `https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        token
      );
      return {
        id: run.id,
        headSha: run.head_sha ?? "",
        runAttempt: run.run_attempt ?? 1,
        startedAt: run.run_started_at ?? run.created_at,
        jobs: (jobs.jobs ?? []).map((job) => ({
          name: job.name,
          conclusion: job.conclusion,
          startedAt: job.started_at,
          completedAt: job.completed_at,
        })),
      };
    })
  );
}

function parseArgs(argv) {
  const out = {
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
    if (argv[i] === "--repo" && argv[i + 1]) out.repo = argv[++i];
    else if (argv[i] === "--workflow" && argv[i + 1]) out.workflow = argv[++i];
    else if (argv[i] === "--runs" && argv[i + 1]) out.runs = Number(argv[++i]);
    else if (argv[i] === "--chronic-red-days" && argv[i + 1])
      out.chronicRedDays = Number(argv[++i]);
    else if (argv[i] === "--floor" && argv[i + 1])
      out.floor = Number(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === "--rung" && argv[i + 1]) out.rung = Number(argv[++i]);
    else if (argv[i] === "--escape-workflow" && argv[i + 1])
      out.escapeWorkflow = argv[++i];
  }
  if (out.rung == null) out.rung = WORKFLOW_RUNG[out.workflow] ?? null;
  return out;
}

async function main() {
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

  const quarantine = existsSync(QUARANTINE_PATH)
    ? (JSON.parse(readFileSync(QUARANTINE_PATH, "utf8")).lanes ?? {})
    : {};
  const today = new Date().toISOString().slice(0, 10);

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
        `::warning title=Escapes unmeasured::could not read ${args.escapeWorkflow} runs (${error.message}); the escape column is empty this run rather than zero`
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
