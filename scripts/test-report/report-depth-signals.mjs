/** Persist every perf/scale measurement in the durable run summary. */
export function collectLaneSeries(results) {
  const series = {};
  for (const result of results ?? []) {
    const owner = String(result?.owner ?? "");
    if (!owner) continue;
    for (const measurement of result.measurements ?? []) {
      if (!Number.isFinite(Number(measurement?.value))) continue;
      const key = `${owner}::${String(measurement.name ?? "measurement")}`;
      series[key] = {
        owner,
        name: String(measurement.name ?? "measurement"),
        lane: String(result.lane ?? "nightly"),
        value: Number(measurement.value),
        unit: String(measurement.unit ?? ""),
        budget: Number.isFinite(Number(measurement.budget))
          ? Number(measurement.budget)
          : null,
      };
    }
  }
  return series;
}

/** Per-owner Playwright flake rates from durable run classifications. */
export function calculateFlakeRates(currentEvidence, historyPoints) {
  const owners = new Set();
  for (const point of historyPoints ?? []) {
    for (const owner of point.playwrightOwnerIds ?? []) owners.add(owner);
  }
  for (const row of currentEvidence ?? []) {
    if (row.source === "playwright") owners.add(row.owner);
  }
  return [...owners]
    .map((owner) => {
      let runs = 0;
      let flaky = 0;
      for (const point of historyPoints ?? []) {
        if ((point.playwrightOwnerIds ?? []).includes(owner)) runs += 1;
        if ((point.flakyOwnerIds ?? []).includes(owner)) flaky += 1;
      }
      const current = (currentEvidence ?? []).find(
        (row) => row.source === "playwright" && row.owner === owner
      );
      if (current) {
        runs += 1;
        if (current.status === "flaky") flaky += 1;
      }
      return {
        owner,
        runs,
        flaky,
        rate: runs ? Math.round((flaky / runs) * 10_000) / 100 : 0,
      };
    })
    .sort(
      (left, right) =>
        right.rate - left.rate || left.owner.localeCompare(right.owner)
    );
}

/** Coverage/mutation values that are weak even when their configured floor passes. */
export function findAbsoluteWeaknesses(
  coverageRows,
  mutationRows,
  { coverageHeadroom = 15, mutationMinimum = 60 } = {}
) {
  const weaknesses = [];
  for (const row of coverageRows ?? []) {
    if (
      Number.isFinite(row.lines) &&
      Number.isFinite(row.lineFloor) &&
      row.lines - row.lineFloor >= coverageHeadroom
    ) {
      weaknesses.push({
        kind: "coverage-floor-lag",
        scope: row.scope,
        value: row.lines,
        floor: row.lineFloor,
      });
    }
  }
  for (const row of mutationRows ?? []) {
    if (Number.isFinite(row.score) && row.score < mutationMinimum) {
      weaknesses.push({
        kind: "weak-mutation",
        scope: row.scope,
        value: row.score,
        floor: row.floor,
      });
    }
  }
  return weaknesses;
}

/** Floors that have lagged the same high-water level for N consecutive runs. */
export function sustainedRatchetCandidates(
  currentSeries,
  historyPoints,
  floors,
  { sustainedRuns = 3, marginPoints = 2 } = {}
) {
  const prior = (historyPoints ?? []).slice(
    Math.max(0, (historyPoints?.length ?? 0) - (sustainedRuns - 1))
  );
  if (prior.length !== sustainedRuns - 1) return [];
  const candidates = [];
  for (const [key, floor] of Object.entries(floors ?? {})) {
    const values = [
      ...prior.map((point) => point.floorSeries?.[key]),
      currentSeries?.[key],
    ];
    if (
      values.length !== sustainedRuns ||
      values.some((value) => !Number.isFinite(Number(value)))
    )
      continue;
    const candidate = Math.floor(
      Math.min(...values.map(Number)) - marginPoints
    );
    if (candidate > Number(floor)) {
      candidates.push({ key, floor: Number(floor), candidate, values });
    }
  }
  return candidates.sort((left, right) => left.key.localeCompare(right.key));
}

/** Infra mismatches that occupied the same cell for too many full runs. */
export function agedInfraMismatches(
  currentIds,
  historyPoints,
  { maxConsecutiveRuns = 3 } = {}
) {
  const prior = (historyPoints ?? []).slice(
    Math.max(0, (historyPoints?.length ?? 0) - (maxConsecutiveRuns - 1))
  );
  if (prior.length !== maxConsecutiveRuns - 1) return [];
  return [...new Set(currentIds)].filter((id) =>
    prior.every((point) => (point.infraMismatchCellIds ?? []).includes(id))
  );
}

/**
 * Drop `_`-prefixed / non-scope meta keys from a floors-style config
 * (e.g. coverage-floors `_comment`) so they never render as coverage rows.
 */
export function filterFloorConfigEntries(floorConfig) {
  return Object.entries(floorConfig ?? {}).filter(
    ([key, value]) =>
      !key.startsWith("_") &&
      key !== "approvedDeviation" &&
      (typeof value === "number" || (value && typeof value === "object"))
  );
}

/**
 * Merge per-lane marker maps written as `lane-starts-<lane>.json` (and the
 * legacy single `lane-starts.json`) so merge-multiple never last-write-wins.
 */
export function mergeLaneMarkers(markerMaps) {
  const merged = {};
  for (const map of markerMaps ?? []) {
    if (!map || typeof map !== "object") continue;
    for (const [lane, at] of Object.entries(map)) {
      if (typeof at === "string" && at) merged[lane] = at;
    }
  }
  return merged;
}
