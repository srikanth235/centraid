/** Persist every perf/scale measurement in the durable run summary. */
export function collectLaneSeries(results) {
  const series = {};
  for (const result of results ?? []) {
    const base = String(result?.owner ?? "");
    if (!base) continue;
    // Platform-keyed mobile evidence (#781): keep iOS and Android as distinct
    // trend series instead of last-write-wins over one shared owner key.
    const platform = String(result?.platform ?? "");
    const owner = platform ? `${base} [${platform}]` : base;
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
    if (
      Number.isFinite(row.branches) &&
      Number.isFinite(row.branchFloor) &&
      row.branches - row.branchFloor >= coverageHeadroom
    ) {
      weaknesses.push({
        kind: "coverage-floor-lag",
        scope: `${row.scope} (branches)`,
        value: row.branches,
        floor: row.branchFloor,
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
 * Match a coverage-floor scope glob against a repo-relative file path.
 *
 * Mirrors how vitest resolves threshold globs (picomatch), because the report
 * must agree with the gate: `*` matches within one path segment, `**` crosses
 * segments, and `{a,b}` alternates. A plain `startsWith` prefix — which this
 * replaced — silently renders every scope narrower than a directory (such as
 * `packages/client/src/*.{ts,tsx}`, #656 Layer 1B) as an unmeasured empty row.
 *
 * Kept dependency-free on purpose: `generate.mjs` is executed from synthetic
 * roots that have no `node_modules`.
 *
 * @param {string} scope Floor-config key.
 * @returns {(file: string) => boolean} Predicate over repo-relative paths.
 */
export function scopeMatcher(scope) {
  let pattern = "";
  for (let i = 0; i < scope.length; i++) {
    const char = scope[i];
    if (char === "*") {
      if (scope[i + 1] === "*") {
        // `**/` may also match zero segments, so `a/**/b.ts` covers `a/b.ts`.
        if (scope[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else pattern += "[^/]*";
    } else if (char === "?") pattern += "[^/]";
    else if (char === "{") pattern += "(?:";
    else if (char === "}") pattern += ")";
    else if (char === ",") pattern += "|";
    else pattern += char.replace(/[.+^$()|[\]\\]/u, "\\$&");
  }
  const re = new RegExp(`^${pattern}$`, "u");
  return (file) => re.test(file);
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
