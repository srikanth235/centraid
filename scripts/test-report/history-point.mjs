function numeric(value) {
  return value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

function idList(value) {
  return Array.isArray(value) ? [...value] : [];
}

function countRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, numeric(entry)])
      .filter(([, entry]) => entry != null)
  );
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function historyPoint(record) {
  return {
    label: String(record.label ?? ""),
    passed: numeric(record.passed),
    failed: numeric(record.failed),
    stale: numeric(record.stale),
    cellsPassed: numeric(record.cellsPassed),
    cellsFailed: numeric(record.cellsFailed),
    cellsMissing: numeric(record.cellsMissing),
    unhandledErrors: numeric(record.unhandledErrors),
    missingCellIds: idList(record.missingCellIds),
    failedCellIds: idList(record.failedCellIds),
    infraMismatchCellIds: idList(record.infraMismatchCellIds),
    floorSeries: objectRecord(record.floorSeries),
    laneSeries: objectRecord(record.laneSeries),
    flakyOwnerIds: idList(record.flakyOwnerIds),
    playwrightOwnerIds: idList(record.playwrightOwnerIds),
    verdict:
      typeof record.verdict === "string" && record.verdict
        ? record.verdict
        : null,
    appSeatCells: countRecord(record.appSeatCells),
    appStateCells: countRecord(record.appStateCells),
    adversaryCounts: countRecord(record.adversaryCounts),
    candidate:
      typeof record.candidate === "string" && record.candidate
        ? record.candidate
        : null,
    lanes: laneRecord(record.lanes),
  };
}

function laneRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set([
    "passed",
    "failed",
    "parked",
    "no-evidence",
    "degraded",
  ]);
  const out = {};
  for (const [lane, entry] of Object.entries(value)) {
    const verdict = entry?.verdict;
    if (!allowed.has(verdict)) continue;
    out[lane] = { verdict, durationMs: numeric(entry?.durationMs) };
  }
  return out;
}
