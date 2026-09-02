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

import { laneSeverity } from "./severity.mjs";

/** The 30-run history codes the sparkline draws. */
export const RUN_CODES = Object.freeze({
  passed: 1,
  failed: 0,
  parked: 2,
  "no-evidence": 3,
});

/** The p95 of a list of numbers, or null when there is nothing to measure. */
export function p95(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

/**
 * The trailing history for one lane, newest last, as verdict words.
 * @param {object[]} history durable history points, oldest first
 * @param {string} lane the lane id
 * @param {string} tonight tonight's verdict word
 */
export function laneHistory(history, lane, tonight, limit = 30) {
  const past = history
    .map((point) => point.lanes?.[lane]?.verdict ?? "no-evidence")
    .slice(-(limit - 1));
  return [...past, tonight].slice(-limit);
}

/** The pass rate over the runs that actually ran (parked and absent excluded). */
export function passRate(words) {
  const ran = words.filter((word) => word === "passed" || word === "failed");
  return ran.length === 0
    ? null
    : Math.round(
        (100 * ran.filter((word) => word === "passed").length) / ran.length
      );
}

/** How many candidates in a row this lane has been red, counting back. */
export function consecutiveReds(words) {
  let count = 0;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (words[index] !== "failed") break;
    count += 1;
  }
  return count;
}

/**
 * Build the lane board.
 * @param {{laneRegistry: object[], evidence: Map<string, object>, previousEvidence: Map<string, object>, history: object[], claims: object}} input the lane registry, tonight's and last night's evidence, the history and the claims file
 */
export function buildLaneBoard({
  laneRegistry,
  evidence,
  previousEvidence,
  history,
  claims,
}) {
  const claimRows = claims.claims ?? [];
  const rows = laneRegistry.map((lane) => {
    const tonight = evidence.get(lane.id) ?? null;
    const previous = previousEvidence.get(lane.id) ?? null;
    const verdict = tonight?.verdict ?? "no-evidence";
    const words = laneHistory(history, lane.id, verdict);
    const durations = history
      .map((point) => point.lanes?.[lane.id]?.durationMs)
      .filter((value) => Number.isFinite(value));
    if (Number.isFinite(tonight?.durationMs))
      durations.push(tonight.durationMs);

    const observedP95 = p95(durations);
    const overBudget =
      observedP95 !== null && lane.budgetMs > 0 && observedP95 > lane.budgetMs;
    const rate = passRate(words);
    const firstFailingCase = (tonight?.cases ?? []).find(
      (entry) => entry.verdict === "failed"
    );

    return {
      lane: lane.id,
      rung: lane.rung,
      platform: lane.platform,
      status: tonight?.parked ? "parked" : lane.status,
      severity: laneSeverity(lane, claimRows),
      // A lane whose p95 has walked past its rung budget is red on its own
      // account, with the number to cut to — the budget is a bound, not a
      // verdict (docs/decisions.md G-deadline), so it degrades rather than
      // failing the product claim.
      verdict: verdict === "passed" && overBudget ? "degraded" : verdict,
      observedVerdict: verdict,
      durationMs: tonight?.durationMs ?? null,
      budgetMs: lane.budgetMs,
      p95Ms: observedP95,
      overBudget,
      history: words,
      passRate: rate,
      demote: lane.rung === 2 && rate !== null && rate < 99,
      consecutiveReds: consecutiveReds(words),
      lastGreen: lastGreenSha(history, lane.id, tonight),
      parked: tonight?.parked ?? null,
      parkedSince: parkStart(history, lane.id),
      firstRed: firstRedSha(history, lane.id, tonight, verdict),
      firstFailingCase: firstFailingCase?.id ?? null,
      cases: tonight?.cases ?? [],
      qualities: tonight?.tags?.qualities ?? lane.qualities ?? [],
      surfaces: tonight?.tags?.surfaces ?? lane.surfaces ?? [],
      previousVerdict: previous?.verdict ?? null,
      ageHours: redAgeHours(history, lane.id, verdict),
      outOfBand: false,
    };
  });

  const counts = {
    passed: 0,
    failed: 0,
    parked: 0,
    "no-evidence": 0,
    degraded: 0,
  };
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;

  return {
    rows: rows.sort((a, b) => a.rung - b.rung || a.lane.localeCompare(b.lane)),
    counts,
  };
}

/** The most recent candidate SHA on which this lane passed. */
function lastGreenSha(history, lane, tonight) {
  if (tonight?.verdict === "passed") return tonight.candidate ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.lanes?.[lane]?.verdict === "passed")
      return point.candidate ?? point.label ?? null;
  }
  return null;
}

/** The candidate on which the current red streak started. */
function firstRedSha(history, lane, tonight, verdict) {
  if (verdict !== "failed") return null;
  let sha = tonight?.candidate ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.lanes?.[lane]?.verdict !== "failed") break;
    sha = point.candidate ?? point.label ?? sha;
  }
  return sha;
}

/** The night this lane's park began, from the history. */
function parkStart(history, lane) {
  let start = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.lanes?.[lane]?.verdict !== "parked") break;
    start = point.label ?? start;
  }
  return start;
}

/** Hours since the first red of the current streak, against the 24 h SLA. */
function redAgeHours(history, lane, verdict) {
  if (verdict !== "failed") return null;
  let nights = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].lanes?.[lane]?.verdict !== "failed") break;
    nights += 1;
  }
  // Nights are the only resolution the durable history carries; a first red
  // tonight is reported as 0 h and ages in 24 h steps from there.
  return nights * 24;
}
