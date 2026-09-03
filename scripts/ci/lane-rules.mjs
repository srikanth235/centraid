#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

export const RUNG_BUDGET_MS = Object.freeze(
  Object.fromEntries(
    Object.entries(
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "../../tests/budgets.json"),
          "utf8"
        )
      ).rungs
    ).filter(([key]) => !key.startsWith("_"))
  )
);

export const WORKFLOW_RUNG = Object.freeze({
  "ci.yml": 2,
  "candidate.yml": 3,
  "e2e.yml": 4,
  "soak-weekly.yml": 5,
  "interop-weekly.yml": 5,
  "enrichment-live-weekly.yml": 5,
  "hygiene.yml": 5,
});

export const MAX_PARK_DAYS = 30;
export const MAX_PARKED_LANES = 3;
export const PARK_AFTER_REDS = 3;
export const RUNG2_PASS_FLOOR = 0.99;
export const PROMOTE_AFTER_ESCAPES = 2;

export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function laneDurations(runs) {
  const out = new Map();
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

export function countEscapes(deepRuns, greenRung2Shas) {
  const out = new Map();
  for (const run of deepRuns) {
    if (!greenRung2Shas.has(run.headSha)) continue;
    for (const job of run.jobs ?? []) {
      if (job.conclusion === "success" || job.conclusion === "skipped")
        continue;
      if (job.conclusion == null) continue;
      out.set(job.name, (out.get(job.name) ?? 0) + 1);
    }
  }
  return out;
}

export function greenShas(runs) {
  const out = new Set();
  for (const run of runs) {
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

export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function applyLaneRules({
  rates,
  streaks,
  durations,
  escapes,
  quarantine,
  rung,
  today,
}) {
  const findings = [];
  const budgetMs = RUNG_BUDGET_MS[rung];

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
        detail: `caught ${count} regression(s) in the trailing window on a SHA whose rung-2 gate was green. Promote it to rung 2 if its p95 fits the 15-minute budget; if it does not, this is a "make it fit" issue instead. (The escape count is an over-approximation — see countEscapes in scripts/ci/lane-rules.mjs.)`,
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

  if (Number.isFinite(budgetMs)) {
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

export function overallVerdict(quarantine, today) {
  const reasons = [];
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
