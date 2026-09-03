import { laneSeverity } from "./severity.mjs";

export const RUN_CODES = Object.freeze({
  passed: 1,
  failed: 0,
  parked: 2,
  "no-evidence": 3,
});

export function p95(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  ];
}

export function laneHistory(history, lane, tonight, limit = 30) {
  const past = history
    .map((point) => point.lanes?.[lane]?.verdict ?? "no-evidence")
    .slice(-(limit - 1));
  return [...past, tonight].slice(-limit);
}

export function passRate(words) {
  const ran = words.filter((word) => word === "passed" || word === "failed");
  return ran.length === 0
    ? null
    : Math.round(
        (100 * ran.filter((word) => word === "passed").length) / ran.length
      );
}

export function consecutiveReds(words) {
  let count = 0;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (words[index] !== "failed") break;
    count += 1;
  }
  return count;
}

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

function lastGreenSha(history, lane, tonight) {
  if (tonight?.verdict === "passed") return tonight.candidate ?? null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.lanes?.[lane]?.verdict === "passed")
      return point.candidate ?? point.label ?? null;
  }
  return null;
}

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

function parkStart(history, lane) {
  let start = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.lanes?.[lane]?.verdict !== "parked") break;
    start = point.label ?? start;
  }
  return start;
}

function redAgeHours(history, lane, verdict) {
  if (verdict !== "failed") return null;
  let nights = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].lanes?.[lane]?.verdict !== "failed") break;
    nights += 1;
  }
  return nights * 24;
}
