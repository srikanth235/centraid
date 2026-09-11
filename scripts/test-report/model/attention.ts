/**
 * Blockers, since-yesterday and the attention queue (#915 Wave 3, §1–§3).
 *
 * All three read the same rows, which is the point: the per-lane rolling issue
 * (`rolling-issue-body.mjs`) is rendered from `buildAttention()` too, so the
 * issue body and §3 cannot disagree about who owes what by when.
 */

import { dict } from "../record.ts";
import type { Loose } from "../record.ts";
import { SEVERITY_RANK } from "./severity.ts";

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: unknown, days: unknown) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return new Date(parsed + Number(days) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function dayGap(from: unknown, to: unknown) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / 86_400_000)
    : null;
}

/**
 * §1 — S1 and S2 reds only, with the bisection bounds already computed.
 * @param {{rows: Loose[], today: string}} input the lane board rows and the night being reported
 */
export function buildBlockers({
  rows,
  today,
}: {
  rows: Loose[];
  today: string;
}) {
  return rows
    .filter(
      (row) =>
        row.verdict === "failed" &&
        (row.severity === "S1" || row.severity === "S2")
    )
    .map((row) => ({
      severity: row.severity,
      lane: row.lane,
      case: row.firstFailingCase,
      platform: row.platform,
      firstRed: row.firstRed,
      lastGreen: row.lastGreen,
      owner: row.owner ?? null,
      ageHours: row.ageHours ?? 0,
      overSla: Number(row.ageHours ?? 0) > 24,
      deadline: `${addDays(today, 1)} (24 h to owned)`,
      issue: dict(row.parked).issue ?? null,
    }))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[String(a.severity)] ?? 9) -
          (SEVERITY_RANK[String(b.severity)] ?? 9) ||
        Number(b.ageHours) - Number(a.ageHours)
    );
}

/**
 * §3 — one row per lane needing a human, oldest first, each with a concrete
 * deadline: owned-by, fix-or-park-by, the park's expiry, or a revisit trigger.
 * iOS and Android are separate lanes, so they are always separate rows.
 * @param {{rows: Loose[], today: string, sla: number}} input the lane board rows and the night being reported
 */
export function buildAttention({
  rows,
  today,
  sla = 24,
}: {
  rows: Loose[];
  today: string;
  sla?: number;
}) {
  const queue: Loose[] = [];
  for (const row of rows) {
    if (row.verdict === "passed") continue;
    let state = row.verdict;
    let deadline = null;
    const parked = dict(row.parked);
    if (row.parked) {
      state = "parked";
      deadline = `expires ${parked.until}`;
    } else if (row.verdict === "failed") {
      state = "failed";
      deadline =
        Number(row.ageHours ?? 0) >= sla
          ? `fix or park by ${addDays(today, 1)}`
          : `owned by ${addDays(today, 1)}`;
    } else if (row.verdict === "degraded") {
      state = "degraded";
      deadline = `back in band or budget by ${addDays(today, 7)}`;
    } else if (row.verdict === "no-evidence") {
      state = "no evidence";
      deadline = `write evidence or register the absence by ${addDays(today, 1)}`;
    }
    queue.push({
      severity: row.severity,
      lane: row.lane,
      platform: row.platform,
      state,
      owner: row.owner ?? null,
      ageDays:
        row.parked && row.parkedSince ? dayGap(row.parkedSince, today) : null,
      ageHours: row.ageHours ?? 0,
      deadline,
      issue: parked.issue ?? null,
      why: row.firstFailingCase ?? "",
    });
  }
  // Oldest first: the age of the debt is what the queue is sorted by, with
  // severity breaking ties so an S1 never sits below an S4 of the same age.
  return queue.sort((a, b) => {
    const ageA = Number(a.ageDays ?? Number(a.ageHours) / 24);
    const ageB = Number(b.ageDays ?? Number(b.ageHours) / 24);
    return (
      ageB - ageA ||
      (SEVERITY_RANK[String(a.severity)] ?? 9) -
        (SEVERITY_RANK[String(b.severity)] ?? 9)
    );
  });
}

/**
 * §2 — six columns, computed candidate-to-candidate so every entry is a code
 * change rather than weather.
 * @param {{rows: Loose[], previousEvidence: Map<string, Loose>, today: string}} input the lane board rows and the night being reported
 */
export function buildSinceYesterday({
  rows,
  previousEvidence,
  today,
}: {
  rows: Loose[];
  previousEvidence: Map<string, unknown>;
  today: string;
}) {
  const newRed = [];
  const newGreen = [];
  const newlyParked = [];
  const expiring = [];
  const outOfBand = [];
  const budgetPressure = [];

  for (const row of rows) {
    const before = dict(previousEvidence.get(String(row.lane))).verdict ?? null;
    if (row.verdict === "failed" && before !== "failed") {
      newRed.push({
        lane: row.lane,
        why: `${row.firstFailingCase ?? "lane"} · ${row.severity}`,
      });
    }
    if (
      row.verdict === "passed" &&
      (before === "failed" || before === "parked")
    ) {
      newGreen.push({ lane: row.lane, why: `was ${before}` });
    }
    const parked = dict(row.parked);
    if (row.parked && before !== "parked") {
      newlyParked.push({
        lane: row.lane,
        why: `until ${parked.until} · #${parked.issue}`,
      });
    }
    if (row.parked) {
      const days = dayGap(today, parked.until);
      if (days !== null && days <= 7) {
        expiring.push({
          lane: row.lane,
          why: `expires ${parked.until} (${days}d) · #${parked.issue} · will count as red`,
        });
      }
    }
    if (row.outOfBand)
      outOfBand.push({
        lane: row.lane,
        why: row.bandWhy ?? "outside its noise band",
      });
    const p95Ms = Number(row.p95Ms);
    const budgetMs = Number(row.budgetMs);
    if (Number.isFinite(p95Ms) && budgetMs > 0 && p95Ms / budgetMs > 0.8) {
      budgetPressure.push({
        lane: row.lane,
        why: `${Math.round(p95Ms / 60_000)} min of ${Math.round(budgetMs / 60_000)} budget`,
      });
    }
  }

  return { newRed, newGreen, newlyParked, expiring, outOfBand, budgetPressure };
}
