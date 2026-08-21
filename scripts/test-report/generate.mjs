// governance: allow-repo-hygiene file-size-limit (#474) this generator was
// already at 498/500 before the durable-history reader landed, so any addition
// trips the cap; the report is one model built in a single pass and then
// rendered, and splitting the reader from the model it feeds would scatter the
// evidence-collection vocabulary across files without making either half
// independently testable. Worth a real decomposition, but not inside a CI fix.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { EXPECTED_GREY } from "./expected-grey.mjs";
import {
  calculateFlakeRates,
  agedInfraMismatches,
  applyExpectedGrey,
  cellIdentityRegressions,
  cellsMissingRatchet,
  collectLaneSeries,
  collectPlaywrightEvidence,
  collectRegisteredOwners,
  collectEnvGatedOwners,
  extractUnhandledErrors,
  filterFloorConfigEntries,
  findAbsoluteWeaknesses,
  findUnmatchedOwners,
  findUnmappedEvidence,
  mergeLaneMarkers,
  reconcileJobConclusions,
  resolvePlaywrightOwner,
  scopeMatcher,
  sustainedRatchetCandidates,
  summarizeCellStates,
  worstEvidenceByOwner,
} from "./report-signals.mjs";
import {
  coverageScopesBelowFloor,
  writeSummarySidecars,
} from "./summary-markdown.mjs";
import { validateMatrix } from "./validate-matrix.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const flags = parseFlags(process.argv.slice(2));
const matrixPath = path.resolve(
  flags.matrix ?? path.join(root, "tests/matrix.json")
);
const outputPath = path.resolve(
  flags.output ?? path.join(root, "dist/test-report/index.html")
);
const reportScope = String(flags.scope ?? process.env.TEST_REPORT_SCOPE ?? "");
const laneMarkers = await readLaneMarkers(
  path.resolve(
    flags["lane-markers"] ?? path.join(root, "artifacts/test-results")
  )
);
const maxEvidenceAgeMs =
  Number(
    flags["max-age-hours"] ??
      process.env.TEST_REPORT_MAX_EVIDENCE_AGE_HOURS ??
      36
  ) *
  60 *
  60 *
  1_000;
const matrix = await readJson(matrixPath, {
  dimensions: [],
  surfaces: [],
  flows: [],
});
const validation = await validateMatrix(matrix, { root });
const coverage = await readJson(
  path.resolve(
    flags.coverage ?? path.join(root, "coverage/coverage-summary.json")
  ),
  null
);
const floors = await readJson(
  path.join(root, "tests/coverage-floors.json"),
  {}
);
const vitest = await readJson(
  path.resolve(
    flags.vitest ?? path.join(root, "artifacts/test-results/vitest.json")
  ),
  null
);
const playwright = await readPlaywright(
  path.resolve(flags.playwright ?? path.join(root, "artifacts/test-results"))
);
const e2e = await readLane(
  path.resolve(flags.e2e ?? path.join(root, "artifacts/e2e"))
);
const perf = await readLane(
  path.resolve(flags.perf ?? path.join(root, "artifacts/perf"))
);
const scale = await readLane(
  path.resolve(flags.scale ?? path.join(root, "artifacts/scale"))
);
const enrichmentLiveResult = await readJson(
  path.resolve(
    flags["enrichment-live"] ??
      path.join(root, "artifacts/enrichment-live/result.json")
  ),
  null
);
// #532 mutation scores (nightly Stryker) — grey when absent, same path as perf/scale.
const mutationScores = await readJson(
  path.resolve(
    flags.mutation ?? path.join(root, "artifacts/mutation/scores.json")
  ),
  null
);
const mutationFloors = await readJson(
  path.join(root, "tests/mutation-floors.json"),
  {}
);
// Durable, gh-pages-committed summary series. Preferred trend source because it
// survives the 7-day/10GB eviction of the `quality-history-` Actions cache that
// feeds artifacts/perf and artifacts/scale.
const durableHistory = await readDurableHistory(
  path.resolve(flags.history ?? path.join(root, "artifacts/report-history")),
  Number(flags["history-limit"] ?? 30) || 30
);
const runUrl =
  process.env.GITHUB_SERVER_URL &&
  process.env.GITHUB_REPOSITORY &&
  process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

const evidence = collectEvidence(vitest, playwright, e2e, perf, scale, {
  laneMarkers,
  maxEvidenceAgeMs,
  nowMs: Date.now(),
  registeredOwners: collectRegisteredOwners(matrix),
  runUrl,
});
const enrichmentLive = buildEnrichmentLive(enrichmentLiveResult, {
  laneMarkers,
  maxEvidenceAgeMs,
  maxEvidenceAgeMsByLane: { "enrichment-live": 8 * 24 * 60 * 60 * 1_000 },
  nowMs: Date.now(),
  runUrl,
});
const appEngineGrid = buildAppEngineGrid(matrix, evidence);
const appSeatGrid = buildAppSeatGrid(matrix);
const appStateGrid = buildAppStateGrid(matrix);
// #781 — reclassify registered no-lane absences AFTER normal cell states are
// derived, so real evidence always wins and only enumerated no-evidence cells
// become expected-grey (void the moment their lane has a start marker).
const expectedGrey = applyExpectedGrey(
  buildCells(matrix, evidence, validation.errors, {
    laneMarkers,
    reportScope,
  }),
  EXPECTED_GREY,
  laneMarkers
);
const cells = expectedGrey.cells;
const qualities = buildQualities(matrix.qualities, evidence);
const coverageRows = collectCoverage(coverage, floors);
const vitestFiles = await collectVitestFiles(vitest);
const laneResults = [...perf, ...scale];
const laneSeries = collectLaneSeries(laneResults);
const unhandledErrors = extractUnhandledErrors(vitest);
const cellStateCounts = summarizeCellStates(cells);
const envGatedOwners = await collectEnvGatedOwners(matrix, { root, readFile });
// Orphaned agent/Playwright evidence (owner not on any matrix cell/flow).
const unmapped = findUnmappedEvidence(
  evidence.filter((item) => ["e2e", "playwright"].includes(item.source)),
  matrix,
  {
    normalizeOwner: normalizeFile,
  }
);
const unmatchedOwners =
  reportScope === "nightly"
    ? findUnmatchedOwners(evidence, matrix, {
        normalizeOwner: normalizeFile,
        // #781 — owners of registered expected-grey cells have no lane to
        // produce evidence in; their silence is the recorded absence, not a
        // second failure. Void once the lane exists (applyExpectedGrey drops
        // them from this set when the lane marker appears).
        ignoreOwners: expectedGrey.expectedAbsentOwners,
      })
    : [];
const qualityOpen = await readQualityOpen(path.join(root, "QUALITY.md"));
const jobConclusions = await readJson(
  path.resolve(
    flags["job-conclusions"] ??
      path.join(root, "artifacts/test-results/job-conclusions.json")
  ),
  null
);
const summary = {
  passed: evidence.filter((item) => item.status === "passed").length,
  failed: evidence.filter((item) => item.status === "failed").length,
  skipped: evidence.filter((item) => item.status === "skipped").length,
  skippedTests: vitestFiles.reduce((sum, file) => sum + file.skipped, 0),
  envGated: vitestFiles.reduce((sum, file) => sum + file.envGated, 0),
  stale:
    evidence.filter((item) => item.status === "stale").length +
    validation.errors.filter((error) => error.includes("owner does not exist"))
      .length,
  unhandledErrors: unhandledErrors.length,
  unhandledErrorMessages: unhandledErrors,
  // Lane/cell honesty: failed = evidence ran and failed; missing = not run.
  cellsFailed: cellStateCounts.cellsFailed,
  cellsMissing: cellStateCounts.cellsMissing,
  cellsFlaky: cellStateCounts.cellsFlaky,
  cellsOwnerSilent: cellStateCounts.cellsOwnerSilent,
  cellsLaneDidNotRun: cellStateCounts.cellsLaneDidNotRun,
  cellsInfraMismatch: cellStateCounts.cellsInfraMismatch,
  cellsEvidenceUnmatched: cellStateCounts.cellsEvidenceUnmatched,
  // #781 — named, budgeted absences (no lane exists); never inside cellsMissing.
  cellsExpectedGrey: cellStateCounts.cellsExpectedGrey,
  expectedGreyCellIds: expectedGrey.applied,
  missingCellIds: cells
    .filter((cell) =>
      [
        "missing",
        "evidence-unmatched",
        "owner-silent",
        "lane-did-not-run",
      ].includes(cell.state)
    )
    .map((cell) => cell.id),
  failedCellIds: cells
    .filter((cell) => ["failed", "infra-mismatch"].includes(cell.state))
    .map((cell) => cell.id),
  infraMismatchCellIds: cells
    .filter((cell) => cell.state === "infra-mismatch")
    .map((cell) => cell.id),
  envGatedOwners,
  unmappedEvidence: unmapped.unmappedEvidence,
  unmappedFailed: unmapped.failedUnmapped.map((item) => item.owner),
  unmatchedOwners,
  // #839 Wave 0 — declaration counts for the app-axis grids. They are counted
  // separately from `cells*` on purpose: nothing here is evidence, so nothing
  // here may reach the nightly zero-grey or ratchet arithmetic.
  appSeatCells: countAxisCells(appSeatGrid),
  appStateCells: countAxisCells(appStateGrid),
  cellsSolid: cells.filter((cell) => cell.assessment === "solid").length,
  cellsPartial: cells.filter((cell) => cell.assessment === "partial").length,
  cellsGap: cells.filter((cell) => cell.assessment === "gap").length,
  cellsNotApplicable: cells.filter((cell) => cell.assessment === "skip").length,
  laneSeries,
  flakyOwnerIds: evidence
    .filter((item) => item.source === "playwright" && item.status === "flaky")
    .map((item) => item.owner),
  playwrightOwnerIds: evidence
    .filter((item) => item.source === "playwright")
    .map((item) => item.owner),
};
const jobRecon = reconcileJobConclusions(jobConclusions, summary);
summary.failedJobs = jobRecon.failedJobs;
summary.silentAllClear = jobRecon.silentAllClear;
summary.jobReconciliation = jobRecon.message;
const missingRatchet = cellsMissingRatchet(
  summary.cellsMissing,
  durableHistory
);
summary.cellsMissingPrior = missingRatchet.prior;
summary.cellsMissingRose = missingRatchet.rose;
summary.cellsMissingDelta = missingRatchet.delta;
const identityRegressions = cellIdentityRegressions(summary, durableHistory);
summary.newMissingCellIds = identityRegressions.newMissing;
summary.newFailedCellIds = identityRegressions.newFailed;

const mutationRows = collectMutationRows(mutationScores, mutationFloors);
summary.floorSeries = collectFloorSeries(coverageRows, mutationRows);
summary.floorRatchetCandidates = sustainedRatchetCandidates(
  summary.floorSeries,
  durableHistory,
  collectFloorBaselines(coverageRows, mutationRows),
  floors._ratchetPolicy
);
summary.agedInfraMismatchCellIds = agedInfraMismatches(
  summary.infraMismatchCellIds,
  durableHistory
);
summary.absoluteWeaknesses = findAbsoluteWeaknesses(
  coverageRows,
  mutationRows,
  {
    coverageHeadroom:
      Number(floors._ratchetPolicy?.floorLagWarningPoints) || 15,
    mutationMinimum: Number(mutationFloors._absoluteWeaknessBelow) || 60,
  }
);
summary.flakeRates = calculateFlakeRates(evidence, durableHistory);
const model = {
  generatedAt: new Date().toISOString(),
  matrix,
  appEngineGrid,
  appSeatGrid,
  appStateGrid,
  enrichmentLive,
  cells,
  qualities,
  coverageRows,
  mutationRows,
  slowest: vitestFiles.sort((a, b) => b.duration - a.duration).slice(0, 10),
  skipDebt: vitestFiles.flatMap((file) =>
    file.skippedItems.map((item) => ({ file: file.file, ...item }))
  ),
  packageRuntime: packageRuntime(vitestFiles),
  laneResults,
  qualityOpen,
  summary,
  reportScope,
  healthHistory: [
    ...durableHistory,
    historyPoint({ label: "this run", ...summary }),
  ],
  validationErrors: validation.errors,
};

const reportDir = path.dirname(outputPath);
await mkdir(reportDir, { recursive: true });
await writeFile(outputPath, render(model), "utf8");
const { jsonPath: summaryJsonPath } = await writeSummarySidecars(
  reportDir,
  {
    generatedAt: model.generatedAt,
    ...summary,
    coverageBelowFloor: coverageScopesBelowFloor(coverageRows),
    validationErrorCount: validation.errors.length,
  },
  { reportUrl: process.env.TEST_REPORT_PUBLIC_URL || undefined }
);
console.log(`test report: ${path.relative(root, outputPath)}`);
console.log(`test report summary: ${path.relative(root, summaryJsonPath)}`);
if (validation.errors.length) {
  for (const error of validation.errors) console.error(`matrix: ${error}`);
  process.exitCode = 1;
}
// Honesty exits (#535/#587): no orphaned evidence and zero grey after nightly.
if (unmapped.unmapped.length) {
  for (const item of unmapped.unmapped) {
    console.error(`unmapped evidence: ${item.owner} (${item.status})`);
  }
  process.exitCode = 1;
}
if (unmatchedOwners.length) {
  for (const owner of unmatchedOwners) {
    console.error(`declared owner produced no evidence key: ${owner}`);
  }
  process.exitCode = 1;
}
if (jobRecon.silentAllClear) {
  console.error(`job reconciliation: ${jobRecon.message}`);
  process.exitCode = 1;
}
if (missingRatchet.rose) {
  console.error(
    `cellsMissing rose: prior=${missingRatchet.prior} current=${missingRatchet.current} delta=+${missingRatchet.delta}`
  );
  // Main (per-push) always has more greys than a full nightly history point —
  // fail the ratchet only on full/nightly reports (#535 F5 / F7).
  if (reportScope !== "main") process.exitCode = 1;
}
if (reportScope === "nightly" && summary.cellsMissing > 0) {
  console.error(
    `nightly zero-grey contract: ${summary.cellsMissing} cell(s) have no evidence`
  );
  process.exitCode = 1;
}
if (
  reportScope === "nightly" &&
  (identityRegressions.newMissing.length ||
    identityRegressions.newFailed.length)
) {
  console.error(
    `new cell regressions: missing=[${identityRegressions.newMissing.join(", ")}] failed=[${identityRegressions.newFailed.join(", ")}]`
  );
  process.exitCode = 1;
}
if (
  reportScope === "nightly" &&
  (summary.floorRatchetCandidates.length ||
    summary.agedInfraMismatchCellIds.length)
) {
  if (summary.floorRatchetCandidates.length) {
    console.error(
      `sustained floor ratchet due: ${summary.floorRatchetCandidates
        .map((row) => `${row.key} ${row.floor}->${row.candidate}`)
        .join(", ")}`
    );
  }
  if (summary.agedInfraMismatchCellIds.length) {
    console.error(
      `infra mismatch exceeded max age: ${summary.agedInfraMismatchCellIds.join(", ")}`
    );
  }
  process.exitCode = 1;
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) continue;
    result[current.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Load lane start markers. Accepts a single JSON file (legacy) or a directory
 * of `lane-starts*.json` shards written by prepare.mjs (#535 lane-starts merge).
 */
async function readLaneMarkers(target) {
  try {
    const info = await stat(target);
    if (info.isFile()) return (await readJson(target, {})) ?? {};
  } catch {
    // fall through to directory / glob merge
  }
  const dir = target.endsWith(".json") ? path.dirname(target) : target;
  try {
    const files = (await readdir(dir))
      .filter(
        (file) => file === "lane-starts.json" || file.startsWith("lane-starts-")
      )
      .filter((file) => file.endsWith(".json"))
      .sort();
    const maps = await Promise.all(
      files.map((file) => readJson(path.join(dir, file), {}))
    );
    return mergeLaneMarkers(maps);
  } catch {
    return {};
  }
}

async function readLane(directory) {
  try {
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort();
    return (
      await Promise.all(
        files.map((file) => readJson(path.join(directory, file), null))
      )
    ).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read the append-only summary series published to gh-pages
 * (`test-report/history/`). Accepts the directory, its `index.json`, or a bare
 * directory of `<slug>.json` records. Returns oldest-first points.
 */
async function readDurableHistory(target, limit) {
  const index = await readJson(
    target.endsWith(".json") ? target : path.join(target, "index.json"),
    null
  );
  let records = Array.isArray(index?.entries) ? index.entries : null;
  if (!records) {
    const files = (await readdir(target).catch(() => []))
      .filter((file) => file.endsWith(".json") && file !== "index.json")
      .sort();
    records = (
      await Promise.all(
        files.map((file) => readJson(path.join(target, file), null))
      )
    ).filter(Boolean);
  }
  const points = records
    .map((record) =>
      historyPoint({
        label: record.slug ?? record.date,
        ...record.summary,
        ...record,
      })
    )
    .filter((point) => point.label);
  points.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return points.slice(Math.max(0, points.length - limit));
}

function historyPoint(record) {
  const numeric = (value) =>
    value == null || value === "" || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  return {
    label: String(record.label ?? ""),
    passed: numeric(record.passed),
    failed: numeric(record.failed),
    stale: numeric(record.stale),
    cellsFailed: numeric(record.cellsFailed),
    cellsMissing: numeric(record.cellsMissing),
    unhandledErrors: numeric(record.unhandledErrors),
    missingCellIds: Array.isArray(record.missingCellIds)
      ? [...record.missingCellIds]
      : [],
    failedCellIds: Array.isArray(record.failedCellIds)
      ? [...record.failedCellIds]
      : [],
    infraMismatchCellIds: Array.isArray(record.infraMismatchCellIds)
      ? [...record.infraMismatchCellIds]
      : [],
    floorSeries:
      record.floorSeries && typeof record.floorSeries === "object"
        ? record.floorSeries
        : {},
    laneSeries:
      record.laneSeries && typeof record.laneSeries === "object"
        ? record.laneSeries
        : {},
    flakyOwnerIds: Array.isArray(record.flakyOwnerIds)
      ? [...record.flakyOwnerIds]
      : [],
    playwrightOwnerIds: Array.isArray(record.playwrightOwnerIds)
      ? [...record.playwrightOwnerIds]
      : [],
  };
}

async function readPlaywright(target) {
  const single = await readJson(target, undefined);
  if (single) return [{ lane: "playwright", report: single }];
  try {
    const files = (await readdir(target)).filter((file) =>
      file.endsWith("-playwright.json")
    );
    return (
      await Promise.all(
        files.map(async (file) => ({
          lane: file.replace(/\.json$/u, ""),
          report: await readJson(path.join(target, file), null),
        }))
      )
    ).filter((entry) => entry.report);
  } catch {
    return [];
  }
}

function normalizeFile(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(`${root.replaceAll("\\", "/")}/`, "");
}

function collectEvidence(
  vitestJson,
  playwrightReports,
  e2eResults,
  perfResults,
  scaleResults,
  freshness
) {
  const items = [];
  for (const result of vitestJson?.testResults ?? vitestJson?.files ?? []) {
    const assertions = result.assertionResults ?? result.tests ?? [];
    const raw =
      result.status ??
      (assertions.some((test) => test.status === "failed")
        ? "failed"
        : "passed");
    const lastAt = isoAt(
      result.endTime ?? result.startTime ?? vitestJson?.startTime
    );
    items.push({
      owner: normalizeFile(result.name ?? result.filepath),
      status: evidenceStatus(raw, "vitest", lastAt, freshness),
      duration:
        Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) ||
        result.duration ||
        0,
      lastAt,
      source: "vitest",
      assertions: assertions.map((assertion) => ({
        name: String(
          assertion.fullName ??
            assertion.ancestorTitles?.concat(assertion.title ?? []).join(" ") ??
            assertion.title ??
            assertion.name ??
            "unnamed"
        ),
        status: normalizeStatus(assertion.status),
      })),
      runUrl: freshness.runUrl,
    });
  }
  for (const { lane, report } of playwrightReports) {
    const lastAt = isoAt(report.stats?.startTime);
    const configRoot = report.config?.rootDir ?? "";
    for (const result of collectPlaywrightEvidence(report, {
      lane,
      resolveOwner: (owner) =>
        resolvePlaywrightOwner(owner, {
          repoRoot: root,
          configRoot,
          registeredOwners: freshness.registeredOwners,
        }),
    })) {
      items.push({
        ...result,
        status: evidenceStatus(result.status, lane, lastAt, freshness),
        lastAt,
        source: "playwright",
        runUrl: freshness.runUrl,
      });
    }
  }
  for (const [source, results] of [
    ["e2e", e2eResults],
    ["perf", perfResults],
    ["scale", scaleResults],
  ]) {
    for (const result of results) {
      const wallClock = (result.measurements ?? []).find(
        (measurement) => measurement.name === "wall clock"
      );
      const lastAt = result.history?.at(-1)?.at ?? result.capturedAt ?? null;
      items.push({
        owner: normalizeFile(result.owner),
        status: evidenceStatus(result.status, result.lane, lastAt, freshness),
        duration:
          wallClock?.unit === "ms" ? wallClock.value : (result.durationMs ?? 0),
        lastAt,
        source,
        // #781 — platform-keyed mobile evidence carries which side produced it.
        platform: result.platform ?? null,
        error: result.error ?? result.message ?? null,
        measurements: result.measurements ?? [],
        runUrl: freshness.runUrl,
      });
    }
  }
  return items;
}

function isoAt(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value).toISOString();
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function evidenceStatus(status, lane, lastAt, freshness) {
  const normalized = normalizeStatus(status);
  if (!lastAt) return "stale";
  const capturedMs = Date.parse(lastAt);
  if (!Number.isFinite(capturedMs)) return "stale";
  const laneStartedMs = Date.parse(freshness.laneMarkers[lane] ?? "");
  if (Number.isFinite(laneStartedMs) && capturedMs < laneStartedMs)
    return "stale";
  const maxAge =
    freshness.maxEvidenceAgeMsByLane?.[lane] ?? freshness.maxEvidenceAgeMs;
  if (freshness.nowMs - capturedMs > maxAge) return "stale";
  return normalized;
}

function buildEnrichmentLive(result, freshness) {
  if (!result) {
    return {
      owner: "packages/model-runtime/src/model-goldens.live.test.ts",
      lane: "enrichment-live",
      status: "missing",
      lastAt: null,
      detail: "No weekly real-weight artifact is available.",
    };
  }
  const lastAt = isoAt(result.capturedAt);
  const status = evidenceStatus(
    result.status,
    "enrichment-live",
    lastAt,
    freshness
  );
  return {
    owner: normalizeFile(result.owner),
    lane: "enrichment-live",
    status,
    lastAt,
    detail:
      status === "stale"
        ? "The last real-weight run is older than eight days."
        : (result.error ??
          "Capability handshake, embedding, OCR, and face goldens."),
    runUrl: freshness.runUrl,
  };
}

function normalizeStatus(status) {
  if (["passed", "pass", "success"].includes(status)) return "passed";
  if (status === "flaky") return "flaky";
  if (status === "infra-mismatch") return "infra-mismatch";
  if (["failed", "fail", "timedOut", "interrupted"].includes(status))
    return "failed";
  if (["skipped", "pending", "todo"].includes(status)) return "skipped";
  return "missing";
}

function buildAppEngineGrid(manifest, evidenceItems) {
  const flows = new Map((manifest.flows ?? []).map((flow) => [flow.id, flow]));
  // Worst-status-wins: platform-keyed evidence (#781) records one item per
  // platform under the same owner, and a green platform must not mask a red one.
  const evidenceByOwner = worstEvidenceByOwner(evidenceItems, {
    normalizeOwner: normalizeFile,
  });
  return {
    engines: manifest.appEngines?.engines ?? [],
    apps: (manifest.appEngines?.apps ?? []).map((app) => ({
      id: app.id,
      cells: (manifest.appEngines?.engines ?? []).map((engine) => {
        const declared = app.engines?.[engine.id];
        if (declared?.status === "skip") {
          return {
            engine: engine.id,
            state: "skipped",
            detail: `${declared.reason} (${declared.citation})`,
          };
        }
        const flow = flows.get(declared?.flow);
        const result = flow
          ? evidenceByOwner.get(normalizeFile(flow.owner))
          : undefined;
        return {
          engine: engine.id,
          state: result?.status ?? "missing",
          detail: flow?.owner ?? "missing conformance gate",
        };
      }),
    })),
  };
}

/**
 * Grid B — blueprint app × seat (#839 Wave 0, gap G6).
 *
 * These cells are DECLARATIONS, not health: an app × seat cell names the
 * proof that owns that seat, and no lane reports per-seat evidence yet
 * (Wave 1 names the flows). So an owned cell renders neutral — "an owner is
 * declared" — and is deliberately NOT green, which in this report means
 * "evidence ran and passed". Nothing here reaches `buildCells`, so the
 * nightly zero-grey contract is untouched by design.
 */
function buildAppSeatGrid(manifest) {
  const seats = manifest.seats ?? [];
  return {
    seats,
    apps: (manifest.appSeats?.apps ?? []).map((app) => ({
      id: app.id,
      cells: seats.map((seat) => {
        const declared = app.seats?.[seat.id];
        if (declared?.status === "owned")
          return {
            column: seat.id,
            state: "declared",
            detail: declared.owner,
            badge: declared.tier,
          };
        if (declared?.status === "skip")
          return {
            column: seat.id,
            state: "skipped",
            detail: `${declared.reason} (${declared.citation})`,
            badge: declared.citation,
          };
        return {
          column: seat.id,
          state: "unowned",
          detail: `no seat owner yet — tracked by #${declared?.trackingIssue ?? "?"}`,
          badge: `#${declared?.trackingIssue ?? "?"}`,
        };
      }),
    })),
  };
}

/**
 * Grid D — blueprint app × designed state (#839 Wave 0, gap G7). Same
 * declaration-not-health rule as grid B; the partition mirrors each app's
 * `app.json#states`, so an `excluded` cell is a structural exclusion the
 * manifest itself carries, never an unbuilt state in disguise.
 */
function buildAppStateGrid(manifest) {
  const states = manifest.appStates?.states ?? [];
  const trackingIssue = manifest.appStates?.trackingIssue;
  return {
    states,
    apps: (manifest.appStates?.apps ?? []).map((app) => ({
      id: app.id,
      cells: states.map((state) => {
        const declared = app.states?.[state.id];
        if (declared?.status === "owned")
          return {
            column: state.id,
            state: "declared",
            detail: declared.owner,
          };
        if (declared?.status === "excluded")
          return {
            column: state.id,
            state: "skipped",
            detail: "structurally excluded by this app's manifest",
          };
        return {
          column: state.id,
          state: "unowned",
          detail: `no owner yet — tracked by #${trackingIssue ?? "?"}`,
        };
      }),
    })),
  };
}

/** Fold either app-axis grid into its {declared, unowned, skipped} counts. */
function countAxisCells(grid) {
  const counts = { declared: 0, unowned: 0, skipped: 0 };
  for (const app of grid.apps ?? [])
    for (const cell of app.cells ?? [])
      if (cell.state in counts) counts[cell.state] += 1;
  return counts;
}

function buildCells(
  manifest,
  evidenceItems,
  validationErrors,
  {
    laneMarkers: laneMarkersLocal = {},
    reportScope: reportScopeLocal = "",
  } = {}
) {
  const staleOwners = new Set(
    validationErrors
      .filter((error) => error.includes("owner does not exist:"))
      .map((error) => error.split("owner does not exist: ")[1])
  );
  // Worst-status-wins across platform-keyed evidence files (#781): the same
  // owner may report per-platform items and the cell must show the worst.
  const evidenceByOwner = worstEvidenceByOwner(evidenceItems);
  return manifest.surfaces.flatMap((surface) =>
    manifest.dimensions.map((dimension) => {
      const cellId = `${surface.id}.${dimension.id}`;
      const cellOwner = manifest.cellOwners[cellId];
      const flows = manifest.flows.filter(
        (flow) => flow.surface === surface.id && flow.dimension === dimension.id
      );
      const owners = [];
      if (cellOwner) {
        owners.push({
          name: "Cell evidence owner",
          tier: cellOwner.tier,
          owner: cellOwner.owner,
        });
      }
      for (const flow of flows) {
        if (!owners.some((owner) => owner.owner === flow.owner))
          owners.push(flow);
      }
      const ownerResults = owners.map((owner) => ({
        ...owner,
        latest: evidenceByOwner.get(owner.owner) ?? {
          status: staleOwners.has(owner.owner) ? "stale" : "missing",
          duration: 0,
          lastAt: null,
        },
      }));
      const results = ownerResults.map((owner) => owner.latest);
      let state = "missing";
      if (results.some((result) => result.status === "infra-mismatch"))
        state = "infra-mismatch";
      else if (results.some((result) => result.status === "failed"))
        state = "failed";
      else if (results.some((result) => result.status === "flaky"))
        state = "flaky";
      else if (
        owners.some((owner) => staleOwners.has(owner.owner)) ||
        results.some((result) => result.status === "stale")
      )
        state = "stale";
      else if (
        results.length &&
        results.every((result) => result.status === "passed")
      )
        state = "passed";
      else if (results.some((result) => result.status === "skipped"))
        state = "skipped";
      else if (surface.assessment[dimension.id] === "skip") state = "skipped";
      else if (surface.assessment[dimension.id] === "gap") state = "gap";
      else if (reportScopeLocal === "nightly" && owners.length) {
        const expectedMarkers = owners
          .map((owner) => expectedLaneMarker(owner))
          .filter(Boolean);
        const basenameCollision = owners.some((owner) =>
          evidenceItems.some(
            (item) =>
              item.owner !== owner.owner &&
              path.basename(item.owner) === path.basename(owner.owner)
          )
        );
        state = basenameCollision
          ? "evidence-unmatched"
          : expectedMarkers.some((marker) => laneMarkersLocal[marker])
            ? "owner-silent"
            : "lane-did-not-run";
      }
      return {
        id: `${surface.id}:${dimension.id}`,
        surface: surface.id,
        surfaceLabel: surface.label,
        dimension: dimension.id,
        dimensionLabel: dimension.label,
        lane: dimension.lane,
        assessment: surface.assessment[dimension.id],
        state,
        flows,
        owners: ownerResults,
      };
    })
  );
}

function buildQualities(manifestQualities = [], evidenceItems = []) {
  const evidenceByOwner = new Map();
  for (const item of evidenceItems) {
    const owner = normalizeFile(item.owner);
    const entries = evidenceByOwner.get(owner) ?? [];
    entries.push(item);
    evidenceByOwner.set(owner, entries);
  }
  return manifestQualities.map((quality) => {
    const gates = quality.gates.map((gate) => {
      const candidates = evidenceByOwner.get(normalizeFile(gate.owner)) ?? [];
      const statuses = candidates.flatMap((candidate) => {
        if (!gate.evidence) return [];
        if (candidate.assertions?.length)
          return candidate.assertions
            .filter((assertion) => assertion.name.includes(gate.evidence))
            .map((assertion) => assertion.status);
        if (candidate.name?.includes(gate.evidence)) return [candidate.status];
        return [];
      });
      const status = statuses.includes("failed")
        ? "failed"
        : statuses.includes("passed")
          ? "passed"
          : (statuses[0] ?? "missing");
      return { ...gate, status };
    });
    const existing = gates.filter((gate) => gate.status !== "missing").length;
    const status =
      gates.length === 0
        ? "missing"
        : gates.some((gate) => gate.status === "failed")
          ? "failed"
          : gates.every((gate) => gate.status === "passed")
            ? "passed"
            : "partial";
    return { ...quality, gates, existing, status };
  });
}

function expectedLaneMarker(owner) {
  if (owner.tier === "perf") return "perf";
  if (owner.tier === "scale") return "scale";
  // #781 — the accessibility owner is a per-PR node --test gate, not a vitest
  // file: the vitest marker existing never meant this owner's lane ran, and
  // mapping it to "vitest" mislabelled every nightly as "owner-silent".
  if (owner.tier === "accessibility") return "accessibility";
  if (owner.owner.startsWith("apps/web/tests/e2e/")) return "web-playwright";
  if (owner.owner.startsWith("apps/desktop/tests/e2e/"))
    return "desktop-playwright";
  if (owner.tier === "e2e") return "e2e";
  return "vitest";
}

async function collectVitestFiles(json) {
  return Promise.all(
    (json?.testResults ?? json?.files ?? []).map(async (result) => {
      const file = normalizeFile(result.name ?? result.filepath);
      const skipped = (result.assertionResults ?? result.tests ?? []).filter(
        (test) => ["skipped", "pending", "todo"].includes(test.status)
      ).length;
      let envGated = 0;
      if (skipped) {
        try {
          const source = await readFile(path.join(root, file), "utf8");
          if (
            /process\.env|\.skipIf\(|\.runIf\(|t\.skip\(|platform\s*[!=]==?/u.test(
              source
            )
          ) {
            envGated = skipped;
          }
        } catch {
          envGated = 0;
        }
      }
      return {
        file,
        duration:
          Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) ||
          result.duration ||
          0,
        status: normalizeStatus(result.status),
        skipped,
        envGated,
        skippedItems: (result.assertionResults ?? result.tests ?? [])
          .filter((test) =>
            ["skipped", "pending", "todo"].includes(test.status)
          )
          .map((test) => ({
            name: String(test.fullName ?? test.title ?? test.name ?? "unnamed"),
            reason: String(
              test.failureMessages?.[0] ??
                test.message ??
                (envGated ? "environment/platform gate" : "no reason reported")
            ),
            envGated: envGated > 0,
          })),
      };
    })
  );
}

async function readQualityOpen(file) {
  try {
    const source = await readFile(file, "utf8");
    const section = source.split(/^## Open\s*$/mu)[1]?.split(/^## /mu)[0] ?? "";
    return section
      .split(/\n(?=- )/u)
      .map((entry) => entry.replace(/\s+/gu, " ").trim())
      .filter((entry) => entry.startsWith("- "))
      .map((entry) => entry.slice(2));
  } catch {
    return [];
  }
}

function packageRuntime(files) {
  const totals = new Map();
  for (const file of files) {
    const parts = file.file.split("/");
    const scope = ["packages", "apps"].includes(parts[0])
      ? `${parts[0]}/${parts[1]}`
      : "other";
    totals.set(scope, (totals.get(scope) ?? 0) + file.duration);
  }
  return [...totals]
    .map(([scope, duration]) => ({ scope, duration }))
    .sort((a, b) => b.duration - a.duration);
}

function collectCoverage(summaryLocal, floorConfig) {
  // Skip `_comment` / meta keys — same filter mutation rows already use (#535).
  return filterFloorConfigEntries(floorConfig).map(([scope, floor]) => {
    const target = typeof floor === "number" ? { lines: floor } : floor;
    // Match the way vitest resolves threshold globs (picomatch, `*` does not
    // cross `/`), not a prefix. A prefix matcher silently renders any scope
    // narrower than a directory — `packages/client/src/*.{ts,tsx}` (#656
    // Layer 1B) — as an empty row, so a real gate looks unmeasured here.
    const matches = scopeMatcher(scope);
    const entries = summaryLocal
      ? Object.entries(summaryLocal).filter(
          ([file]) => file !== "total" && matches(normalizeFile(file))
        )
      : [];
    const source =
      scope === "lines"
        ? summaryLocal?.total
        : aggregateCoverage(entries.map(([, value]) => value));
    return {
      scope: scope === "lines" ? "repo-wide" : scope,
      lines: source?.lines?.pct ?? null,
      branches: source?.branches?.pct ?? null,
      lineFloor: target.lines,
      branchFloor: target.branches ?? null,
    };
  });
}

/** #532 — mutation scores vs floors for the test-health report. */
function collectMutationRows(scoresArtifact, floorConfig) {
  const floorsLocal =
    floorConfig && typeof floorConfig === "object"
      ? Object.entries(floorConfig).filter(
          ([key, value]) =>
            !key.startsWith("_") &&
            key !== "approvedDeviation" &&
            typeof value === "number"
        )
      : [];
  const byId = new Map(
    (scoresArtifact?.packages ?? []).map((row) => [row.id, row])
  );
  const ids = new Set([...floorsLocal.map(([id]) => id), ...byId.keys()]);
  return [...ids].sort().map((id) => {
    const floor = floorConfig?.[id];
    const row = byId.get(id);
    return {
      scope: id,
      score: typeof row?.score === "number" ? row.score : null,
      floor: typeof floor === "number" ? floor : null,
      status: row?.status ?? "missing",
    };
  });
}

function collectFloorSeries(coverageRowsLocal, mutationRowsLocal) {
  return Object.fromEntries([
    ...coverageRowsLocal.flatMap((row) => [
      [`coverage:${row.scope}:lines`, row.lines],
      [`coverage:${row.scope}:branches`, row.branches],
    ]),
    ...mutationRowsLocal.map((row) => [`mutation:${row.scope}`, row.score]),
  ]);
}

function collectFloorBaselines(coverageRowsLocal, mutationRowsLocal) {
  return Object.fromEntries(
    [
      ...coverageRowsLocal.flatMap((row) => [
        [`coverage:${row.scope}:lines`, row.lineFloor],
        [`coverage:${row.scope}:branches`, row.branchFloor],
      ]),
      ...mutationRowsLocal.map((row) => [`mutation:${row.scope}`, row.floor]),
    ].filter(([, floorValue]) => Number.isFinite(floorValue))
  );
}

function aggregateCoverage(entries) {
  if (!entries.length) return null;
  const result = {};
  for (const metric of ["lines", "branches"]) {
    const total = entries.reduce(
      (sum, item) => sum + (item[metric]?.total ?? 0),
      0
    );
    const covered = entries.reduce(
      (sum, item) => sum + (item[metric]?.covered ?? 0),
      0
    );
    result[metric] = {
      pct: total ? Math.round((covered / total) * 10_000) / 100 : 100,
    };
  }
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMs(value) {
  if (value == null) return "—";
  return value >= 1_000
    ? `${(value / 1_000).toFixed(2)}s`
    : `${Math.round(value)}ms`;
}

function trendSvg(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return '<span class="muted">No trend yet</span>';
  const min = Math.min(...numbers);
  const span = Math.max(1, Math.max(...numbers) - min);
  const points = numbers
    .map(
      (value, index) =>
        `${(index / (numbers.length - 1)) * 120},${34 - ((value - min) / span) * 28}`
    )
    .join(" ");
  return `<svg class="spark" viewBox="0 0 120 40" role="img" aria-label="Result trend"><polyline points="${points}" /></svg>`;
}

function render(modelLocal) {
  const data = JSON.stringify(modelLocal).replaceAll("<", "\\u003c");
  const qualityRows = (modelLocal.qualities ?? [])
    .map(
      (quality) =>
        `<details class="quality-row"><summary><span class="quality-light ${escapeHtml(quality.status)}" aria-label="${escapeHtml(quality.status)}"></span><strong>${escapeHtml(quality.name)}</strong><span>${escapeHtml(quality.weakestLink)}</span><b>${quality.existing}/${quality.gates.length} gates</b></summary><div class="quality-gates">${quality.gates
          .map(
            (gate) =>
              `<div title="lane: ${escapeHtml(gate.lane)} · cost: ${escapeHtml(gate.wallClockCost)} · knob: ${escapeHtml(gate.knob)} · governance: ${escapeHtml(gate.governance)} · red: ${escapeHtml(gate.redLastDemonstrated)}"><i class="dot ${escapeHtml(gate.blockedBy ? "missing" : gate.status)}"></i><span>${escapeHtml(gate.id)} · ${escapeHtml(gate.name)}${gate.blockedBy ? ` — blocked by ${escapeHtml(gate.blockedBy)}` : ""}</span><code>${escapeHtml(gate.owner)}</code></div>`
          )
          .join("")}</div></details>`
    )
    .join("");
  const existingQualityGates = (modelLocal.qualities ?? []).reduce(
    (sum, quality) => sum + quality.existing,
    0
  );
  const totalQualityGates = (modelLocal.qualities ?? []).reduce(
    (sum, quality) => sum + quality.gates.length,
    0
  );
  const dimensionHeaders = modelLocal.matrix.dimensions
    .map(
      (dimension) =>
        `<th scope="col"><span>${escapeHtml(dimension.label)}</span><small>${escapeHtml(dimension.lane)}</small></th>`
    )
    .join("");
  const rows = modelLocal.matrix.surfaces
    .map((surface, rowIndex) => {
      const surfaceCells = modelLocal.cells.filter(
        (cell) => cell.surface === surface.id
      );
      return `<tr style="--row:${rowIndex}"><th scope="row">${escapeHtml(surface.label)}</th>${surfaceCells
        .map(
          (cell) =>
            `<td><button class="cell ${cell.state} assessment-${cell.assessment}" data-cell="${escapeHtml(cell.id)}" aria-label="${escapeHtml(`${cell.surfaceLabel}, ${cell.dimensionLabel}: ${cell.state}; assessment ${cell.assessment}`)}"><span>${symbol(cell.state)}</span><small>${cell.owners.length || "—"}</small></button></td>`
        )
        .join("")}</tr>`;
    })
    .join("");
  const appEngineHeaders = modelLocal.appEngineGrid.engines
    .map((engine) => `<th scope="col">${escapeHtml(engine.label)}</th>`)
    .join("");
  const appEngineRows = modelLocal.appEngineGrid.apps
    .map(
      (app) =>
        `<tr><th scope="row">${escapeHtml(app.id)}</th>${app.cells
          .map(
            (cell) =>
              `<td class="metric ${escapeHtml(cell.state)}" title="${escapeHtml(cell.detail)}">${symbol(cell.state)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");
  const axisHeaders = (columns) =>
    columns
      .map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`)
      .join("");
  const axisRows = (grid) =>
    grid.apps
      .map(
        (app) =>
          `<tr><th scope="row">${escapeHtml(app.id)}</th>${app.cells
            .map((cell) => {
              const badge = cell.badge
                ? `<small>${escapeHtml(cell.badge)}</small>`
                : "";
              return `<td class="metric axis-${escapeHtml(cell.state)}" title="${escapeHtml(cell.detail)}">${axisSymbol(cell.state)}${badge}</td>`;
            })
            .join("")}</tr>`
      )
      .join("");
  const appSeatHeaders = axisHeaders(modelLocal.appSeatGrid.seats);
  const appSeatRows = axisRows(modelLocal.appSeatGrid);
  const appStateHeaders = axisHeaders(modelLocal.appStateGrid.states);
  const appStateRows = axisRows(modelLocal.appStateGrid);
  const appSeatCounts = modelLocal.summary.appSeatCells ?? {};
  const appStateCounts = modelLocal.summary.appStateCells ?? {};
  const coverageRowsLocal = modelLocal.coverageRows
    .map((row) => {
      const lineState =
        row.lines == null
          ? "missing"
          : row.lines >= row.lineFloor
            ? "passed"
            : "failed";
      const branchState =
        row.branchFloor == null || row.branches == null
          ? "missing"
          : row.branches >= row.branchFloor
            ? "passed"
            : "failed";
      return `<tr><td>${escapeHtml(row.scope)}</td><td class="metric ${lineState}">${row.lines ?? "—"}% <small>/ ${row.lineFloor}%</small></td><td class="metric ${branchState}">${row.branches ?? "—"}% <small>/ ${row.branchFloor ?? "—"}%</small></td></tr>`;
    })
    .join("");
  const mutationRowsLocal = (modelLocal.mutationRows ?? []).length
    ? (modelLocal.mutationRows ?? [])
        .map((row) => {
          const state =
            row.score == null
              ? "missing"
              : row.floor == null || row.score >= row.floor
                ? "passed"
                : "failed";
          return `<tr><td>${escapeHtml(row.scope)}</td><td class="metric ${state}">${row.score == null ? "—" : `${row.score.toFixed(1)}%`} <small>/ ${row.floor ?? "—"}%</small></td><td class="muted">${escapeHtml(row.status)}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="3" class="muted">No mutation scores (nightly Stryker lane)</td></tr>';
  const live = modelLocal.enrichmentLive;
  const liveMetricState = ["missing", "stale"].includes(live.status)
    ? "missing"
    : live.status;
  const enrichmentLiveRow = `<tr><td class="path">${escapeHtml(live.owner)}</td><td class="metric ${escapeHtml(liveMetricState)}">${symbol(live.status)} ${escapeHtml(live.status)}</td><td>${escapeHtml(live.lastAt ?? "—")}</td><td>${escapeHtml(live.detail)}</td></tr>`;
  const runtimeRows = modelLocal.packageRuntime.length
    ? modelLocal.packageRuntime
        .map(
          (row) =>
            `<tr><td>${escapeHtml(row.scope)}</td><td>${formatMs(row.duration)}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="2" class="muted">No Vitest JSON found</td></tr>';
  const slowRows = modelLocal.slowest.length
    ? modelLocal.slowest
        .map(
          (row, index) =>
            `<tr><td>${index + 1}</td><td>${escapeHtml(row.file)}</td><td>${formatMs(row.duration)}</td><td>${row.skipped}</td><td>${row.envGated}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="5" class="muted">No Vitest timing evidence found</td></tr>';
  // Prefer the durable gh-pages series; lane artifacts remain as the fallback
  // (and as per-owner detail) so a first run with no series still renders.
  const durableSeries = modelLocal.healthHistory ?? [];
  const durableTrends =
    durableSeries.length > 1
      ? [
          ["evidence passed", "passed"],
          ["evidence failed", "failed"],
          ["cells not run", "cellsMissing"],
          ["stale owners", "stale"],
        ]
          .map(
            ([label, key]) =>
              `<article class="trend"><div><strong>${escapeHtml(label)}</strong><small>durable series · ${durableSeries.length} runs · latest ${escapeHtml(String(durableSeries.at(-1)?.[key] ?? "—"))}</small></div>${trendSvg(durableSeries.map((point) => point[key]))}</article>`
          )
          .join("")
      : "";
  const laneKeys = [
    ...new Set(
      durableSeries.flatMap((point) => Object.keys(point.laneSeries ?? {}))
    ),
  ].sort();
  const laneTrends = laneKeys.length
    ? laneKeys
        .map((key) => {
          const points = durableSeries
            .map((point) => point.laneSeries?.[key])
            .filter(Boolean);
          const latest = points.at(-1);
          return `<article class="trend"><div><strong>${escapeHtml(latest?.name ?? key)}</strong><small>${escapeHtml(latest?.owner ?? "")} · ${escapeHtml(latest?.lane ?? "nightly")} · latest ${escapeHtml(String(latest?.value ?? "—"))}${escapeHtml(latest?.unit ?? "")}</small></div>${trendSvg(points.map((point) => point.value))}</article>`;
        })
        .join("")
    : '<p class="empty">Perf and scale results are missing. The lane stays visible until nightly evidence arrives.</p>';
  const trends = `${durableTrends}${laneTrends}`;

  const honestyBanners = [];
  if (modelLocal.reportScope === "main") {
    honestyBanners.push(
      `<p class="lede" style="border-left:3px solid var(--blue);padding-left:12px">This is the <strong>per-push / main</strong> slot (CI after merge). It does not include nightly desktop/web/mobile/pairing e2e, perf, or scale. Full product lanes: <a href="../nightly/" style="color:var(--blue)">/test-report/nightly/</a>.</p>`
    );
  }
  if (
    modelLocal.summary.silentAllClear &&
    modelLocal.summary.jobReconciliation
  ) {
    honestyBanners.push(
      `<p class="lede" style="color:var(--red)">${escapeHtml(modelLocal.summary.jobReconciliation)}</p>`
    );
  }
  if (modelLocal.summary.unmappedEvidence) {
    honestyBanners.push(
      `<p class="lede" style="color:var(--amber)">Unmapped e2e evidence: ${modelLocal.summary.unmappedEvidence}${
        (modelLocal.summary.unmappedFailed ?? []).length
          ? ` (${(modelLocal.summary.unmappedFailed ?? []).length} failed: ${escapeHtml((modelLocal.summary.unmappedFailed ?? []).join(", "))})`
          : ""
      }</p>`
    );
  }
  if (modelLocal.summary.cellsMissingRose) {
    honestyBanners.push(
      `<p class="lede" style="color:var(--amber)">cellsMissing rose vs prior durable history: ${modelLocal.summary.cellsMissingPrior} → ${modelLocal.summary.cellsMissing} (Δ+${modelLocal.summary.cellsMissingDelta})</p>`
    );
  }
  if ((modelLocal.summary.floorRatchetCandidates ?? []).length) {
    honestyBanners.push(
      `<p class="lede" style="color:var(--amber)">Sustained floor ratchet due: ${escapeHtml(modelLocal.summary.floorRatchetCandidates.map((row) => `${row.key} ${row.floor}→${row.candidate}`).join(", "))}</p>`
    );
  }
  if ((modelLocal.summary.agedInfraMismatchCellIds ?? []).length) {
    honestyBanners.push(
      `<p class="lede" style="color:var(--red)">Infrastructure mismatch exceeded its three-run maximum age: ${escapeHtml(modelLocal.summary.agedInfraMismatchCellIds.join(", "))}</p>`
    );
  }
  if ((modelLocal.summary.expectedGreyCellIds ?? []).length) {
    const registration = (modelLocal.cells ?? []).find(
      (cell) => cell.state === "expected-grey"
    )?.expectedGrey;
    honestyBanners.push(
      `<p class="lede" style="color:var(--grey)">Named absences (#781 — no evidence lane exists yet): ${modelLocal.summary.expectedGreyCellIds.length} cell(s)${
        registration?.issue
          ? ` · <a href="${escapeHtml(registration.issue)}" style="color:var(--blue)">tracking issue</a>`
          : ""
      }. These go red the night their lane first runs.</p>`
    );
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Centraid test health</title><style>
:root{color-scheme:dark;--text:#ecf3ee;--text-soft:#8f9f98;--panel:#111713;--line:#273129;--bg:#090d0b;--green:#5bd697;--red:#ff766f;--amber:#e9b95c;--blue:#72a9ff;--violet:#b39cff;--cyan:#69d8d0;--grey:#738079;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% -10%,#173126 0,transparent 35%),var(--bg);color:var(--text);font:14px/1.5 var(--sans)}main{width:min(1480px,calc(100% - 40px));margin:auto;padding:56px 0 80px}.eyebrow{color:var(--green);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(34px,5vw,66px);letter-spacing:-.055em;line-height:.95;margin:14px 0 16px;max-width:780px}.lede{color:#afbbb5;font-size:16px;max-width:720px;margin:0}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:44px;align-items:end;margin-bottom:42px}.summary{display:grid;grid-template-columns:repeat(3,92px);gap:8px}.stat{background:#101612;border:1px solid var(--line);border-radius:4px;padding:15px 12px}.stat b{display:block;font-size:25px}.stat small,.muted,small{color:var(--text-soft)}.matrix-shell,.card{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:6px}.matrix-head{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}.matrix-head h2,.card h2{font-size:15px;margin:0;letter-spacing:-.01em}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--text-soft);font-size:12px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.dot.passed{background:var(--green)}.dot.partial{background:var(--cyan)}.dot.failed,.dot.infra-mismatch{background:var(--red)}.dot.flaky{background:var(--violet)}.dot.skipped{background:var(--amber)}.dot.gap{background:#ff9e64}.dot.evidence-unmatched{background:#ff8a65}.dot.owner-silent{background:#ffcb6b}.dot.lane-did-not-run,.dot.stale,.dot.expected-grey{background:var(--grey)}.matrix-scroll{overflow:auto;padding:10px}table{border-collapse:separate;border-spacing:4px;width:100%}.heatmap th{font-size:11px;color:var(--text-soft);font-weight:650;text-align:left;min-width:68px}.heatmap thead th:not(:first-child){height:98px;vertical-align:bottom}.heatmap thead th span{display:block;writing-mode:vertical-rl;transform:rotate(180deg);height:74px}.heatmap thead th small{display:none}.heatmap tbody th{min-width:230px;color:#bdc9c3}.cell{width:100%;min-width:52px;height:40px;border:1px solid transparent;border-radius:3px;color:#07110c;display:flex;justify-content:space-between;align-items:center;padding:0 9px;font:700 13px var(--sans);cursor:pointer;transition:transform .16s,border-color .16s,filter .16s;animation:rise .34s both;animation-delay:calc(var(--row)*28ms)}.cell small{color:inherit;opacity:.65}.cell:hover,.cell:focus-visible{transform:translateY(-2px);filter:brightness(1.12);outline:none;border-color:#fff8}.cell.passed{background:var(--green)}.cell.passed.assessment-partial{background:var(--cyan)}.cell.failed,.cell.infra-mismatch{background:var(--red)}.cell.flaky{background:var(--violet)}.cell.skipped{background:var(--amber)}.cell.gap{background:#ff9e64}.cell.evidence-unmatched{background:#ff8a65}.cell.owner-silent{background:#ffcb6b}.cell.missing,.cell.stale,.cell.lane-did-not-run{background:#46534c;color:#f0f4f1}.cell.expected-grey{background:#39423d;color:#cfd8d2;border:1px dashed #738079}.inspector{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;padding:20px;border-top:1px solid var(--line);min-height:126px}.inspector .kicker{color:var(--text-soft);font-size:12px}.inspector h3{margin:4px 0 0;font-size:18px}.flow-list{display:grid;gap:8px}.flow{display:grid;grid-template-columns:minmax(150px,.45fr) 78px 84px 84px minmax(230px,1fr);gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid #202923}.flow:last-child{border-bottom:0}.tier{color:var(--blue);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.result{font-size:11px;font-weight:750;text-transform:uppercase}.result.passed{color:var(--green)}.result.failed,.result.infra-mismatch{color:var(--red)}.result.flaky{color:var(--violet)}.result.skipped{color:var(--amber)}.result.evidence-unmatched{color:#ff8a65}.result.missing,.result.stale,.result.owner-silent,.result.lane-did-not-run,.result.expected-grey{color:var(--text-soft)}.path{color:#a8b7af;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.card{padding:20px;overflow:auto}.card h2{margin-bottom:14px}.data{border-spacing:0;width:100%}.data th,.data td{text-align:left;border-bottom:1px solid #202923;padding:8px 7px;font-size:12px}.data th{color:var(--text-soft);font-weight:650}.metric.passed{color:var(--green)}.metric.failed{color:var(--red)}.metric.missing{color:var(--text-soft)}.metric.axis-declared{color:var(--blue)}.metric.axis-unowned{color:var(--grey)}.metric.axis-skipped{color:var(--amber)}.metric small{margin-left:4px;opacity:.7}.axis-note{font-size:12px;margin:0 0 12px}.wide{grid-column:1/-1}.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}.trend{display:flex;justify-content:space-between;gap:12px;align-items:center;background:#0c110e;border:1px solid #202923;padding:12px}.trend strong,.trend small{display:block}.spark{width:120px;height:40px}.spark polyline{fill:none;stroke:var(--green);stroke-width:2;vector-effect:non-scaling-stroke}.empty{color:var(--text-soft);border:1px dashed #334038;padding:24px;margin:0}.foot{margin-top:20px;color:var(--text-soft);font-size:12px}@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(max-width:900px){main{width:min(100% - 22px,1480px);padding-top:30px}.hero{grid-template-columns:1fr}.summary{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.inspector{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.matrix-head{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.qualities-shell{margin-bottom:14px;padding:14px 20px;background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:6px}.qualities-shell h2{font-size:15px;margin:0 0 10px}.quality-row{border-top:1px solid var(--line)}.quality-row summary{display:grid;grid-template-columns:14px 180px minmax(0,1fr) 72px;gap:10px;align-items:center;padding:11px 0;cursor:pointer}.quality-row summary b{text-align:right}.quality-light{width:9px;height:9px;border-radius:50%;background:var(--grey)}.quality-light.passed{background:var(--green)}.quality-light.partial{background:var(--cyan)}.quality-light.failed{background:var(--red)}.quality-gates{padding:0 0 10px 24px}.quality-gates>div{display:grid;grid-template-columns:12px minmax(180px,.7fr) minmax(260px,1fr);gap:8px;align-items:center;padding:5px 0}.quality-gates code{color:var(--text-soft);overflow-wrap:anywhere}.quality-debt{color:var(--text-soft);font-size:12px;margin:10px 0 0}@media(max-width:900px){.quality-row summary,.quality-gates>div{grid-template-columns:14px 1fr}.quality-row summary span:nth-of-type(2),.quality-row summary b,.quality-gates code{grid-column:2}}
</style></head><body><main>
<header class="hero"><div><div class="eyebrow">Centraid · test intelligence</div><h1>Product health, with the gaps left visible.</h1><p class="lede">One view across per-PR correctness and nightly journey, performance, and scale evidence. Every absence is classified: wiring, a silent owner, or a lane that did not run.</p>${honestyBanners.join("")}${
    modelLocal.summary.unhandledErrors
      ? `<p class="lede" style="color:var(--red)">Unhandled Vitest errors: ${modelLocal.summary.unhandledErrors} — ${escapeHtml(
          (modelLocal.summary.unhandledErrorMessages ?? [])
            .join(" · ")
            .slice(0, 400)
        )}</p>`
      : ""
  }</div><div class="summary"><div class="stat"><b>${modelLocal.summary.passed}</b><small>evidence passed</small></div><div class="stat"><b>${modelLocal.summary.failed}</b><small>evidence failed</small></div><div class="stat"><b>${modelLocal.summary.cellsSolid ?? 0}</b><small>solid</small></div><div class="stat"><b>${modelLocal.summary.cellsPartial ?? 0}</b><small>partial</small></div><div class="stat"><b>${modelLocal.summary.cellsGap ?? 0}</b><small>declared gaps</small></div><div class="stat"><b>${modelLocal.summary.cellsNotApplicable ?? 0}</b><small>n/a by design</small></div><div class="stat"><b>${modelLocal.summary.cellsMissing ?? 0}</b><small>unproven cells</small></div><div class="stat"><b>${modelLocal.summary.cellsFlaky ?? 0}</b><small>flaky cells</small></div><div class="stat"><b>${modelLocal.summary.unhandledErrors ?? 0}</b><small>unhandled errors</small></div></div></header>
<section class="qualities-shell"><h2>User-facing qualities</h2>${qualityRows}<p class="quality-debt">${existingQualityGates} of ${totalQualityGates} gates exist.</p></section>
<section class="card wide"><h2>Blueprint app × shared engine</h2><div class="matrix-scroll"><table class="data"><thead><tr><th>App</th>${appEngineHeaders}</tr></thead><tbody>${appEngineRows}</tbody></table></div></section>
<section class="card wide"><h2>Blueprint app × seat</h2><p class="muted axis-note">Declared seat ownership, not evidence: ◆ names the proof that owns this app on this seat, · is an unowned seat carrying its tracking issue, – is a seat this app does not take or a held interface, with its citation. ${appSeatCounts.declared ?? 0} owned · ${appSeatCounts.unowned ?? 0} unowned · ${appSeatCounts.skipped ?? 0} held/excluded.</p><div class="matrix-scroll"><table class="data"><thead><tr><th>App</th>${appSeatHeaders}</tr></thead><tbody>${appSeatRows}</tbody></table></div></section>
<section class="card wide"><h2>Blueprint app × designed state</h2><p class="muted axis-note">One column per canonical designed state, mirrored from each app's <code>app.json#states</code>. ◆ names the proof that asserts the state, · is a state nobody owns yet, – is excluded by that app's own manifest. ${appStateCounts.declared ?? 0} owned · ${appStateCounts.unowned ?? 0} unowned · ${appStateCounts.skipped ?? 0} excluded.</p><div class="matrix-scroll"><table class="data"><thead><tr><th>App</th>${appStateHeaders}</tr></thead><tbody>${appStateRows}</tbody></table></div></section>
<section class="matrix-shell"><div class="matrix-head"><h2>Surface × quality dimension</h2><div class="legend"><span><i class="dot passed"></i>solid passed</span><span><i class="dot partial"></i>partial passed</span><span><i class="dot failed"></i>product failed</span><span><i class="dot flaky"></i>flaky</span><span><i class="dot gap"></i>tracked gap</span><span><i class="dot skipped"></i>n/a by design</span><span><i class="dot missing"></i>missing (PR-only)</span><span><i class="dot evidence-unmatched"></i>evidence unmatched</span><span><i class="dot owner-silent"></i>owner silent</span><span><i class="dot lane-did-not-run"></i>lane did not run / stale</span><span><i class="dot expected-grey"></i>named absence (no lane exists, #781)</span><span><i class="dot infra-mismatch"></i>infra mismatch</span></div></div><div class="matrix-scroll"><table class="heatmap"><thead><tr><th>Product surface</th>${dimensionHeaders}</tr></thead><tbody>${rows}</tbody></table></div><div class="inspector" aria-live="polite"><div><span class="kicker" id="inspector-kicker">Select a matrix cell</span><h3 id="inspector-title">Evidence inspector</h3></div><div class="flow-list" id="inspector-flows"><p class="muted">Choose any cell to see its canonical flow owner, tier, lane, latest result, and first error.</p></div></div></section>
<section class="grid"><article class="card wide"><h2>Weekly real-model evidence · eight-day freshness</h2><table class="data"><thead><tr><th>Owner</th><th>Status</th><th>Captured</th><th>Evidence</th></tr></thead><tbody>${enrichmentLiveRow}</tbody></table></article><article class="card"><h2>Coverage vs ratchet floor</h2><table class="data"><thead><tr><th>Scope</th><th>Lines</th><th>Branches</th></tr></thead><tbody>${coverageRowsLocal}</tbody></table></article><article class="card"><h2>Mutation vs ratchet floor</h2><table class="data"><thead><tr><th>Package</th><th>Score</th><th>Status</th></tr></thead><tbody>${mutationRowsLocal}</tbody></table></article><article class="card"><h2>Per-package wall clock</h2><table class="data"><thead><tr><th>Package</th><th>Runtime</th></tr></thead><tbody>${runtimeRows}</tbody></table></article><article class="card wide"><h2>Slowest 10 test files · bloat watch</h2><table class="data"><thead><tr><th>#</th><th>File</th><th>Runtime</th><th>Skipped</th><th>Env-gated</th></tr></thead><tbody>${slowRows}</tbody></table></article><article class="card wide"><h2>Environment-gated matrix owners</h2>${
    (modelLocal.summary.envGatedOwners ?? []).length
      ? `<table class="data"><thead><tr><th>Cell</th><th>Owner</th><th>Env</th><th>Kind</th></tr></thead><tbody>${(
          modelLocal.summary.envGatedOwners ?? []
        )
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.cellId)}</td><td class="path">${escapeHtml(row.owner)}</td><td>${escapeHtml(row.env)}</td><td>${escapeHtml(row.kind)}</td></tr>`
          )
          .join("")}</tbody></table>`
      : '<p class="empty">No solid/partial matrix owners are whole-file env-gated off default CI.</p>'
  }</article><article class="card wide"><h2>Skipped and environment-gated test debt</h2>${
    modelLocal.skipDebt.length
      ? `<table class="data"><thead><tr><th>Owner</th><th>Test</th><th>Reason</th><th>Gate</th></tr></thead><tbody>${modelLocal.skipDebt
          .map(
            (row) =>
              `<tr><td class="path">${escapeHtml(row.file)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.reason)}</td><td>${row.envGated ? "environment" : "skip"}</td></tr>`
          )
          .join("")}</tbody></table>`
      : '<p class="empty">No skipped or environment-gated tests in this evidence set.</p>'
  }</article><article class="card wide"><h2>Playwright flake rate</h2>${
    (modelLocal.summary.flakeRates ?? []).length
      ? `<table class="data"><thead><tr><th>Owner</th><th>Flaky runs</th><th>Observed runs</th><th>Rate</th></tr></thead><tbody>${modelLocal.summary.flakeRates
          .map(
            (row) =>
              `<tr><td class="path">${escapeHtml(row.owner)}</td><td>${row.flaky}</td><td>${row.runs}</td><td>${row.rate}%</td></tr>`
          )
          .join("")}</tbody></table>`
      : '<p class="empty">No Playwright owner history is available.</p>'
  }</article><article class="card wide"><h2>Absolute weakness signals</h2>${
    (modelLocal.summary.absoluteWeaknesses ?? []).length
      ? `<table class="data"><thead><tr><th>Signal</th><th>Scope</th><th>Value</th><th>Floor</th></tr></thead><tbody>${modelLocal.summary.absoluteWeaknesses
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.kind)}</td><td class="path">${escapeHtml(row.scope)}</td><td>${row.value}%</td><td>${row.floor ?? "—"}%</td></tr>`
          )
          .join("")}</tbody></table>`
      : '<p class="empty">No floor-lag or absolute mutation weakness detected.</p>'
  }</article><article class="card wide"><h2>Open field-quality observations</h2>${
    modelLocal.qualityOpen.length
      ? `<ul>${modelLocal.qualityOpen.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : '<p class="empty">QUALITY.md has no open observations.</p>'
  }</article><article class="card wide"><h2>Nightly performance and scale trends</h2><div class="trend-grid">${trends}</div></article></section>
<p class="foot">Generated ${escapeHtml(modelLocal.generatedAt)} · ${modelLocal.matrix.surfaces.length} surfaces · ${modelLocal.matrix.dimensions.length} dimensions · ${modelLocal.matrix.flows.length} canonical flows</p></main>
<script type="application/json" id="report-data">${data}</script><script>
const report=JSON.parse(document.querySelector('#report-data').textContent);const byId=new Map(report.cells.map(cell=>[cell.id,cell]));const kicker=document.querySelector('#inspector-kicker');const title=document.querySelector('#inspector-title');const flows=document.querySelector('#inspector-flows');for(const button of document.querySelectorAll('[data-cell]'))button.addEventListener('click',()=>{const cell=byId.get(button.dataset.cell);kicker.textContent=cell.dimensionLabel+' · '+cell.lane+' · '+cell.state+' · '+cell.assessment;title.textContent=cell.surfaceLabel;flows.innerHTML=cell.owners.length?cell.owners.map(owner=>'<div class="flow"><strong>'+safe(owner.name)+'</strong><span class="tier">'+safe(owner.tier)+'</span><span class="result '+safe(owner.latest.status)+'">'+safe(owner.latest.status)+'</span><span>'+duration(owner.latest.duration)+'</span><span class="path">'+safe(owner.owner)+(owner.latest.error?'<br><strong>Error:</strong> '+safe(owner.latest.error):'')+(owner.latest.runUrl?'<br><a href="'+safe(owner.latest.runUrl)+'">Actions run / artifacts</a>':'')+(owner.latest.attachments?.length?'<br>Attachments: '+owner.latest.attachments.map(item=>safe(item.name??item.path??'attachment')).join(', '):'')+'</span></div>').join(''):'<p class="muted">No evidence owner is expected for this cell. Catalog assessment: '+safe(cell.assessment)+'.</p>';for(const current of document.querySelectorAll('[data-cell][aria-pressed]'))current.removeAttribute('aria-pressed');button.setAttribute('aria-pressed','true')});function duration(value){if(!Number.isFinite(value))return '—';return value>=1000?(value/1000).toFixed(2)+'s':Math.round(value)+'ms'}function safe(value){const span=document.createElement('span');span.textContent=value??'';return span.innerHTML}
</script></body></html>`;
}

/**
 * The app-axis grids (B and D) speak DECLARATION, not health, so they get
 * their own three-symbol alphabet rather than borrowing the evidence one —
 * a declared owner must never be mistaken for a green run.
 */
function axisSymbol(state) {
  return { declared: "◆", unowned: "·", skipped: "–" }[state] ?? "·";
}

function symbol(state) {
  return (
    {
      passed: "✓",
      failed: "×",
      flaky: "≈",
      skipped: "–",
      gap: "?",
      stale: "!",
      missing: "·",
      "owner-silent": "!",
      "lane-did-not-run": "○",
      "infra-mismatch": "⚙",
      "evidence-unmatched": "↯",
      "expected-grey": "◌",
    }[state] ?? "·"
  );
}
