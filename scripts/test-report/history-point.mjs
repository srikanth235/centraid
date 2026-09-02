/**
 * The durable-history whitelist (#535, extended #839 Wave 5).
 *
 * `scripts/test-report/prepare-pages-site.mjs` commits the WHOLE of each run's
 * `summary.json` into the gh-pages series, so the series carries whatever the
 * generator happened to emit that night — including fields that no longer
 * exist, fields that changed meaning, and fields a future run must not read
 * back as health. This function is the read boundary: a history record only
 * reaches the report through a field named here, coerced to a shape the
 * renderer can trust.
 *
 * That is why the list was frozen after #535: adding a field is a promise that
 * every past night either carries it or is honestly null, and `numeric()` /
 * the array guards are what keep an absent field from becoming a zero. Wave 5
 * unfreezes it for exactly the summary fields report v2's verdict strip and
 * adversary panel read back — `verdict`, `appSeatCells`, `appStateCells`, and
 * `adversaryCounts` — each additive and each null/empty on every older night.
 */

/** A finite number, or null. An absent measurement is never a zero. */
function numeric(value) {
  return value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

/** A shallow copy of a string array, or an empty one. */
function idList(value) {
  return Array.isArray(value) ? [...value] : [];
}

/** A plain record of finite numbers, or an empty record. */
function countRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, numeric(entry)])
      .filter(([, entry]) => entry != null)
  );
}

/** A plain record passed through as-is, or an empty record. */
function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Project one durable summary record onto the whitelisted history shape.
 * @param {object} record A stored summary, or this run's summary plus a label.
 * @returns {object} The history point the report may read.
 */
export function historyPoint(record) {
  return {
    label: String(record.label ?? ""),
    passed: numeric(record.passed),
    failed: numeric(record.failed),
    stale: numeric(record.stale),
    // #862 — the verdict bar's "+N green" since last night. Nights recorded
    // before that pass carry no `cellsPassed`, so they read null and the bar
    // renders no green delta at all rather than a movement from zero.
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
    // #839 Wave 5 — report v2's summary fields. Every one of these is null or
    // empty for nights recorded before this wave, which is what the verdict
    // strip's "no prior nightly" and the panel's empty sparkline slots render.
    verdict:
      typeof record.verdict === "string" && record.verdict
        ? record.verdict
        : null,
    appSeatCells: countRecord(record.appSeatCells),
    appStateCells: countRecord(record.appStateCells),
    adversaryCounts: countRecord(record.adversaryCounts),
    // #915 Wave 3 — the ladder's own fields. The lane board's 30-run sparkline,
    // the pass rate and the p95 all read `lanes`, and the trend charts read
    // `laneSeries` above. Every night recorded before this wave carries none of
    // them, so they read as an empty record and a null candidate: an unrecorded
    // night renders as `no evidence` in the sparkline rather than as a pass.
    candidate:
      typeof record.candidate === "string" && record.candidate
        ? record.candidate
        : null,
    lanes: laneRecord(record.lanes),
  };
}

/**
 * The per-lane verdicts of one night, whitelisted the same way every other
 * field here is: an unknown verdict word is dropped rather than trusted, and a
 * duration that is not a finite number reads as null.
 */
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
