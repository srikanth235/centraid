/**
 * The lane health board's model (#915 Wave 3, §4).
 *
 * One row per registered lane on rungs 2–5, whether or not it wrote evidence.
 * A registered lane that said nothing is `no-evidence` — the honest word — and
 * a lane with an unexpired park is `parked` whatever it observed, so the
 * verdict is computed over the lanes that are actually being watched.
 *
 * The demote / promote / park rules of #915 read this table, so the numbers it
 * carries (pass rate on candidates, p95 against the rung budget, consecutive
 * reds) are computed here once rather than in the renderer.
 */

import { bags, dict, finite } from "../record.ts";
import type { Loose } from "../record.ts";
import { laneSeverity } from "./severity.ts";

/** The 30-run history codes the sparkline draws. */
export const RUN_CODES = Object.freeze({
  passed: 1,
  failed: 0,
  parked: 2,
  "no-evidence": 3,
});

/** The p95 of a list of numbers, or null when there is nothing to measure. */
export function p95(values: unknown[]) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

/**
 * The trailing history for one lane, newest last, as verdict words.
 * @param {Loose[]} history durable history points, oldest first
 * @param {string} lane the lane id
 * @param {string} tonight tonight's verdict word
 */
export function laneHistory(
  history: Loose[],
  lane: string,
  tonight: string,
  limit: number = 30
) {
  const past = history
    .map(
      (point) => dict(dict(dict(point).lanes)[lane]).verdict ?? "no-evidence"
    )
    .slice(-(limit - 1));
  return [...past, tonight].slice(-limit);
}

/** The pass rate over the runs that actually ran (parked and absent excluded). */
export function passRate(words: unknown[]) {
  const ran = words.filter((word) => word === "passed" || word === "failed");
  return ran.length === 0
    ? null
    : Math.round(
        (100 * ran.filter((word) => word === "passed").length) / ran.length
      );
}

/** How many candidates in a row this lane has been red, counting back. */
export function consecutiveReds(words: unknown[]) {
  let count = 0;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (words[index] !== "failed") break;
    count += 1;
  }
  return count;
}

/**
 * Build the lane board.
 * @param {{laneRegistry: Loose[], evidence: Map<string, Loose>, previousEvidence: Map<string, Loose>, history: Loose[], claims: Loose}} input the lane registry, tonight's and last night's evidence, the history and the claims file
 */
export function buildLaneBoard({
  laneRegistry,
  evidence,
  previousEvidence,
  history,
  claims,
}: {
  laneRegistry: unknown[];
  evidence: Map<string, unknown>;
  previousEvidence: Map<string, unknown>;
  history: unknown[];
  claims: unknown;
  today?: unknown;
}) {
  const claimRows = Array.isArray(dict(claims).claims)
    ? (dict(claims).claims as unknown[])
    : [];
  const rows = laneRegistry.map((rawLane) => {
    const lane = dict(rawLane);
    const id = String(lane.id ?? "");
    const tonight = dict(evidence.get(id));
    const previous = dict(previousEvidence.get(id));
    const verdict = String(tonight.verdict ?? "no-evidence");
    const words = laneHistory(bags(history), id, verdict);
    const durations = history
      .map((point) => dict(dict(dict(point).lanes)[id]).durationMs)
      .filter(finite);
    if (finite(tonight.durationMs)) durations.push(tonight.durationMs);

    const observedP95 = p95(durations);
    const budgetMs = Number(lane.budgetMs ?? 0);
    const overBudget =
      observedP95 != null && budgetMs > 0 && observedP95 > budgetMs;
    const rate = passRate(words);
    const firstFailingCase = (Array.isArray(tonight.cases) ? tonight.cases : [])
      .map(dict)
      .find((entry) => entry.verdict === "failed");

    return {
      lane: id,
      rung: lane.rung,
      platform: lane.platform,
      status: tonight.parked ? "parked" : lane.status,
      severity: laneSeverity(lane, claimRows),
      // A lane whose p95 has walked past its rung budget is red on its own
      // account, with the number to cut to — the budget is a bound, not a
      // verdict (docs/decisions.md G-deadline), so it degrades rather than
      // failing the product claim.
      verdict: verdict === "passed" && overBudget ? "degraded" : verdict,
      observedVerdict: verdict,
      durationMs: tonight.durationMs ?? null,
      budgetMs,
      p95Ms: observedP95,
      overBudget,
      history: words,
      passRate: rate,
      demote: lane.rung === 2 && rate !== null && rate < 99,
      consecutiveReds: consecutiveReds(words),
      lastGreen: lastGreenSha(history, id, tonight),
      parked: tonight.parked ?? null,
      parkedSince: parkStart(history, id),
      firstRed: firstRedSha(history, id, tonight, verdict),
      firstFailingCase: firstFailingCase?.id ?? null,
      cases: Array.isArray(tonight.cases) ? tonight.cases : [],
      qualities: dict(tonight.tags).qualities ?? lane.qualities ?? [],
      surfaces: dict(tonight.tags).surfaces ?? lane.surfaces ?? [],
      previousVerdict: previous.verdict ?? null,
      ageHours: redAgeHours(history, id, verdict),
      outOfBand: false,
    };
  });

  const counts: Record<string, number> = {
    passed: 0,
    failed: 0,
    parked: 0,
    "no-evidence": 0,
    degraded: 0,
  };
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;

  return {
    rows: rows.sort(
      (a, b) =>
        Number(a.rung) - Number(b.rung) ||
        String(a.lane).localeCompare(String(b.lane))
    ),
    counts,
  };
}

/** The most recent candidate SHA on which this lane passed. */
function lastGreenSha(history: unknown[], lane: string, tonight: Loose) {
  if (tonight.verdict === "passed") return tonight.candidate ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = dict(history[index]);
    if (dict(dict(point.lanes)[lane]).verdict === "passed")
      return point.candidate ?? point.label ?? null;
  }
  return null;
}

/** The candidate on which the current red streak started. */
function firstRedSha(
  history: unknown[],
  lane: string,
  tonight: Loose,
  verdict: unknown
) {
  if (verdict !== "failed") return null;
  let sha = tonight.candidate ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = dict(history[index]);
    if (dict(dict(point.lanes)[lane]).verdict !== "failed") break;
    sha = point.candidate ?? point.label ?? sha;
  }
  return sha;
}

/** The night this lane's park began, from the history. */
function parkStart(history: unknown[], lane: string) {
  let start = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = dict(history[index]);
    if (dict(dict(point.lanes)[lane]).verdict !== "parked") break;
    start = point.label ?? start;
  }
  return start;
}

/** Hours since the first red of the current streak, against the 24 h SLA. */
function redAgeHours(history: unknown[], lane: string, verdict: unknown) {
  if (verdict !== "failed") return null;
  let nights = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (dict(dict(dict(history[index]).lanes)[lane]).verdict !== "failed")
      break;
    nights += 1;
  }
  // Nights are the only resolution the durable history carries; a first red
  // tonight is reported as 0 h and ages in 24 h steps from there.
  return nights * 24;
}
