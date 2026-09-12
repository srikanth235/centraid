#!/usr/bin/env node
/**
 * The lane-health rules table, as code (#915).
 *
 * The issue states six mechanical rules and their automatic actions. They live
 * here rather than inside `lane-health.ts` so each one is a pure function with
 * a fixture beside it: a rule that decides to demote a required lane, or to
 * declare the night a HOLD, has to be readable and testable without a network.
 *
 * | Signal | Rule | Action |
 * | --- | --- | --- |
 * | pass rate on candidates, trailing 30 | rung-2 lane < 99 % | `[lanes] demote <lane>` |
 * | escapes | rung ≥ 3 catches what rung 2 missed, twice in 30 days | `[lanes] promote <lane>` |
 * | consecutive reds on candidates | 3 | park required, 14-day expiry, rolling issue |
 * | park expired | — | counts as red again |
 * | p95 > rung budget | — | lane red, with the number to cut to |
 * | > 3 parks, or any park > 30 days | — | verdict HOLD |
 */
import { readFileSync } from "node:fs";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The ladder's p95 budgets, in milliseconds, keyed by rung.
 *
 * Read from `tests/budgets.json#rungs` rather than held as a literal here
 * (#915 Wave 4): the ladder's own budgets are ratcheted like every other
 * ceiling, so cutting one is free and widening one is a reviewed edit with an
 * approvedDeviation. `_`-prefixed keys are prose, not rungs.
 */
const budgetsRaw: unknown = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "../../tests/budgets.json"),
    "utf8"
  )
);
const rungsRaw =
  isRecord(budgetsRaw) && isRecord(budgetsRaw.rungs) ? budgetsRaw.rungs : {};
export const RUNG_BUDGET_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(rungsRaw)
      .filter(([key]) => !key.startsWith("_"))
      .filter(
        (entry): entry is [string, number] => typeof entry[1] === "number"
      )
  )
);

/** Which rung a workflow's lanes sit on. */
export const WORKFLOW_RUNG: Readonly<Record<string, number>> = Object.freeze({
  "ci.yml": 2,
  "candidate.yml": 3,
  "e2e.yml": 4,
  "soak-weekly.yml": 5,
  "interop-weekly.yml": 5,
  "enrichment-live-weekly.yml": 5,
  "hygiene.yml": 5,
});

/** How long a park may stand before it is itself the problem. */
export const MAX_PARK_DAYS = 30;
/** How many parks the ladder tolerates before the report holds. */
export const MAX_PARKED_LANES = 3;
/** Consecutive reds on candidates before a park becomes mandatory. */
export const PARK_AFTER_REDS = 3;
/** The pass rate a rung-2 lane must hold to stay on the merge gate. */
export const RUNG2_PASS_FLOOR = 0.99;
/** Escapes in the trailing window before a lane is promoted toward rung 2. */
export const PROMOTE_AFTER_ESCAPES = 2;

export interface LaneJob {
  name: string;
  conclusion?: string | null;
  startedAt?: string;
  completedAt?: string;
}

export interface LaneRun {
  headSha?: string;
  jobs?: LaneJob[];
}

export interface RateEntry {
  attempts: number;
  passed: number;
  rate: number;
}

export interface StreakEntry {
  days: number;
  runs: number;
  since: string;
}

export interface ParkEntry {
  issue?: number | string;
  expires?: string;
  why?: string;
}

export interface LaneFinding {
  lane: string;
  kind: string;
  title: string;
  detail: string;
}

/** The p-th percentile of a sample, nearest-rank. */
export function percentile(
  values: readonly number[],
  p: number
): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? null;
}

/** Per-lane durations, in milliseconds, across the given runs. */
export function laneDurations(runs: readonly LaneRun[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const run of runs) {
    for (const job of run.jobs ?? []) {
      const start = Date.parse(job.startedAt ?? "");
      const end = Date.parse(job.completedAt ?? "");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        continue;
      const list = out.get(job.name) ?? [];
      list.push(end - start);
      out.set(job.name, list);
    }
  }
  return out;
}

/**
 * Escapes: a lane red on rung ≥ 3 for a SHA whose rung-2 gate was green.
 *
 * THE APPROXIMATION, STATED. A true escape is "a case rung 2 could have run and
 * did not, that rung 3 caught". Nothing in the Actions API carries case ids
 * across workflows, so this counts the coarser, strictly-larger thing: a red
 * lane on a candidate/nightly run whose `head_sha` also has a fully green
 * `ci.yml` run. That over-counts (the rung-2 gate may have had no lane capable
 * of catching it at all) and never under-counts, which is the correct direction
 * for a signal whose action is "consider promoting this lane". The report says
 * so beside the number; do not quietly tighten the rule without replacing the
 * approximation with case ids from the evidence files.
 */
export function countEscapes(
  deepRuns: readonly LaneRun[],
  greenRung2Shas: ReadonlySet<string>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const run of deepRuns) {
    if (!run.headSha || !greenRung2Shas.has(run.headSha)) continue;
    for (const job of run.jobs ?? []) {
      if (job.conclusion === "success" || job.conclusion === "skipped")
        continue;
      if (job.conclusion == null) continue;
      out.set(job.name, (out.get(job.name) ?? 0) + 1);
    }
  }
  return out;
}

/** The SHAs whose rung-2 gate reported no failure. */
export function greenShas(runs: readonly LaneRun[]): Set<string> {
  const out = new Set<string>();
  for (const run of runs) {
    if (!run.headSha) continue;
    const bad = (run.jobs ?? []).some(
      (job) =>
        job.conclusion != null &&
        job.conclusion !== "success" &&
        job.conclusion !== "skipped"
    );
    if (!bad) out.add(run.headSha);
  }
  return out;
}

/** Whole days between two ISO dates (YYYY-MM-DD), or null. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Apply every rule and return the findings, worst kind first.
 *
 * Each finding carries the issue title the caller should open or update, so the
 * workflow step is a loop rather than a second copy of the rules.
 */
export function applyLaneRules({
  rates,
  streaks,
  durations,
  escapes,
  quarantine,
  rung,
  today,
}: {
  rates: Map<string, RateEntry>;
  streaks: Map<string, StreakEntry>;
  durations: Map<string, number[]>;
  escapes: Map<string, number>;
  quarantine: Record<string, ParkEntry | undefined>;
  rung: number;
  today: string;
}): LaneFinding[] {
  const findings: LaneFinding[] = [];
  const budgetMs = RUNG_BUDGET_MS[String(rung)];

  for (const [lane, entry] of rates) {
    if (rung === 2 && entry.attempts > 0 && entry.rate < RUNG2_PASS_FLOOR) {
      findings.push({
        lane,
        kind: "demote",
        title: `[lanes] demote ${lane}`,
        detail: `first-attempt pass rate ${(entry.rate * 100).toFixed(1)}% over ${entry.attempts} candidate run(s) is below ${(RUNG2_PASS_FLOOR * 100).toFixed(0)}%. A required lane there teaches people to press re-run, and a re-run habit devalues every other lane at once. Demote it to rung 3 (candidate.yml) or fix the flake.`,
      });
    }
  }

  for (const [lane, count] of escapes) {
    if (count >= PROMOTE_AFTER_ESCAPES) {
      findings.push({
        lane,
        kind: "promote",
        title: `[lanes] promote ${lane}`,
        detail: `caught ${count} regression(s) in the trailing window on a SHA whose rung-2 gate was green. Promote it to rung 2 if its p95 fits the 15-minute budget; if it does not, this is a "make it fit" issue instead. (The escape count is an over-approximation — see countEscapes in scripts/ci/lane-rules.ts.)`,
      });
    }
  }

  for (const [lane, streak] of streaks) {
    if (streak.runs < PARK_AFTER_REDS) continue;
    const park = quarantine[lane];
    if (park?.expires && park.expires >= today) continue;
    findings.push({
      lane,
      kind: "park-required",
      title: `[lanes] park ${lane}`,
      detail: `${streak.runs} consecutive red run(s) on candidates since ${streak.since}. Fix it, or park it in tests/quarantine.json#lanes with a 14-day expiry and an issue number. A park is a deadline, never a mute.`,
    });
  }

  for (const [lane, park] of Object.entries(quarantine)) {
    if (!park?.expires) continue;
    if (park.expires < today) {
      findings.push({
        lane,
        kind: "park-expired",
        title: `[lanes] park ${lane}`,
        detail: `the park expired on ${park.expires}. An expired park is no park at all: this lane counts as red again from today.`,
      });
    }
  }

  if (Number.isFinite(budgetMs) && budgetMs !== undefined) {
    for (const [lane, samples] of durations) {
      const p95 = percentile(samples, 0.95);
      if (p95 == null || p95 <= budgetMs) continue;
      findings.push({
        lane,
        kind: "over-budget",
        title: `[lanes] ${lane} is over its rung-${rung} budget`,
        detail: `p95 ${(p95 / 60_000).toFixed(1)} min over ${samples.length} run(s) exceeds the rung-${rung} budget of ${(budgetMs / 60_000).toFixed(0)} min. Cut ${((p95 - budgetMs) / 60_000).toFixed(1)} min, or move the lane to the next rung.`,
      });
    }
  }

  return findings;
}

/** The report-level verdict over the parks ledger. */
export function overallVerdict(
  quarantine: Record<string, ParkEntry | undefined>,
  today: string
): { verdict: "HOLD" | "OK"; reasons: string[] } {
  const reasons: string[] = [];
  const live = Object.entries(quarantine).filter(
    ([, park]) => park?.expires && park.expires >= today
  );
  if (live.length > MAX_PARKED_LANES) {
    reasons.push(
      `${live.length} lanes are parked; more than ${MAX_PARKED_LANES} parked lanes means the ladder is carrying debt it is not paying down`
    );
  }
  for (const [lane, park] of Object.entries(quarantine)) {
    if (!park?.expires) continue;
    const age = daysBetween(park.expires, today);
    if (age != null && age > 0) {
      reasons.push(`the park on \`${lane}\` expired ${age} day(s) ago`);
    }
    const remaining = daysBetween(today, park.expires);
    if (remaining != null && remaining > MAX_PARK_DAYS) {
      reasons.push(
        `the park on \`${lane}\` runs ${remaining} days out; no park may exceed ${MAX_PARK_DAYS} days`
      );
    }
  }
  return { verdict: reasons.length ? "HOLD" : "OK", reasons };
}
