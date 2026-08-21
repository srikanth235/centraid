import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  appAxesFor,
  baseMatrix,
  CAPTURED_AT,
  CAPTURED_MS,
  CELL_ID,
  FRESH_WINDOW_HOURS,
  makeFixtureRoot,
  OWNER,
  runGenerate,
  STALE_AT,
  vitestReport,
  writeJson,
} from "./report-fixture-root.mjs";

/**
 * Honesty-contract tests for the test-health report generator (issue #656
 * Layer 1F). Every case drives the real `generate.mjs` as a subprocess against
 * a synthetic repo root; the harness and its fixtures live in
 * `report-fixture-root.mjs`.
 */

describe("evidence freshness", () => {
  test("counts recent evidence as passed and proves the owning cell", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(root, "in/vitest.json", vitestReport());
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.status).toBe(0);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.stale).toBe(0);
    expect(result.summary.cellsMissing).toBe(0);
  });

  test("marks evidence older than the max age window as stale, not passed", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(
      root,
      "in/vitest.json",
      vitestReport(Date.parse(STALE_AT))
    );
    // No --max-age-hours: the documented 36-hour default applies.
    const result = runGenerate(root, ["--vitest", vitestPath]);
    expect(result.summary.stale).toBe(1);
    expect(result.summary.passed).toBe(0);
  });

  test("marks evidence captured before its lane started as stale", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(root, "in/vitest.json", vitestReport());
    writeJson(root, "markers/lane-starts.json", {
      vitest: "2026-06-01T00:00:00.000Z",
    });
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--lane-markers",
      path.join(root, "markers"),
      // Age alone would keep this evidence fresh; only the lane marker ages it.
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.summary.stale).toBe(1);
    expect(result.summary.passed).toBe(0);
  });

  test("evidence without any timestamp is stale rather than trusted", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(root, "in/vitest.json", {
      testResults: [{ name: OWNER, status: "passed", assertionResults: [] }],
    });
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.summary.stale).toBe(1);
    expect(result.summary.passed).toBe(0);
  });

  test("renders absent real-model evidence grey, never green", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root);
    expect(result.html).toContain(
      "Weekly real-model evidence · eight-day freshness"
    );
    expect(result.html).toContain(
      "No weekly real-weight artifact is available."
    );
    expect(result.html).toContain('class="metric missing">· missing');
  });

  test("keeps weekly real-model evidence fresh for eight days", () => {
    const root = makeFixtureRoot();
    const livePath = writeJson(root, "in/enrichment-live.json", {
      owner: "packages/model-runtime/src/model-goldens.live.test.ts",
      lane: "enrichment-live",
      status: "passed",
      capturedAt: new Date(
        Date.now() - (8 * 24 - 1) * 60 * 60 * 1_000
      ).toISOString(),
    });
    const result = runGenerate(root, ["--enrichment-live", livePath]);
    expect(result.html).toContain('class="metric passed">✓ passed');
  });

  test("marks real-model evidence stale after eight days", () => {
    const root = makeFixtureRoot();
    const livePath = writeJson(root, "in/enrichment-live.json", {
      owner: "packages/model-runtime/src/model-goldens.live.test.ts",
      lane: "enrichment-live",
      status: "passed",
      capturedAt: new Date(
        Date.now() - (8 * 24 + 1) * 60 * 60 * 1_000
      ).toISOString(),
    });
    const result = runGenerate(root, ["--enrichment-live", livePath]);
    expect(result.html).toContain('class="metric missing">! stale');
    expect(result.html).toContain("older than eight days");
  });
});

describe("apps × engines grid", () => {
  test("renders the seat-doctrine citation on structural skips", () => {
    const root = makeFixtureRoot({
      matrix: {
        ...baseMatrix(),
        ...appAxesFor(["locker"]),
        engineRegistry: [
          {
            id: "consent",
            label: "Consent",
            source: [OWNER],
            propertyFlow: null,
            mutationSeed: null,
            appEngineColumn: true,
          },
        ],
        appEngines: {
          seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
          engines: [
            { id: "consent", label: "Consent", flow: "locker-consent" },
          ],
          apps: [
            {
              id: "locker",
              engines: {
                consent: {
                  status: "skip",
                  reason: "Locker is structurally excluded.",
                  citation: "docs/blueprint-seats.md#engine-contracts",
                },
              },
            },
          ],
        },
        flows: [
          {
            id: "locker-consent",
            name: "Locker consent",
            surface: "vault",
            dimension: "correctness",
            tier: "unit",
            owner: OWNER,
            minimumTests: 0,
          },
        ],
      },
    });
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    expect(result.html).toContain(
      "Locker is structurally excluded. (docs/blueprint-seats.md#engine-contracts)"
    );
  });
});

describe("grey-cell classification", () => {
  test("reports a cell with no evidence at all as unproven", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root);
    expect(result.summary.cellsMissing).toBe(1);
    expect(result.summary.missingCellIds).toEqual([CELL_ID]);
    expect(result.summary.passed).toBe(0);
  });

  test("blames a silent owner when its lane demonstrably started", () => {
    const root = makeFixtureRoot();
    writeJson(root, "markers/lane-starts.json", {
      vitest: CAPTURED_AT,
    });
    const result = runGenerate(root, [
      "--scope",
      "nightly",
      "--lane-markers",
      path.join(root, "markers"),
    ]);
    expect(result.summary.cellsOwnerSilent).toBe(1);
    expect(result.summary.cellsLaneDidNotRun).toBe(0);
  });

  test("blames the lane when no lane start marker exists", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root, ["--scope", "nightly"]);
    expect(result.summary.cellsLaneDidNotRun).toBe(1);
    expect(result.summary.cellsOwnerSilent).toBe(0);
  });

  test("reports a failing owner as a failed cell, not a missing one", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(
      root,
      "in/vitest.json",
      vitestReport(CAPTURED_MS, "failed")
    );
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.cellsFailed).toBe(1);
    expect(result.summary.failedCellIds).toEqual([CELL_ID]);
  });
});

describe("honesty exits", () => {
  test("exits non-zero and names the matrix error when an owner file is gone", () => {
    const matrix = baseMatrix();
    matrix.cellOwners["vault.correctness"].owner = "owners/deleted-owner.mjs";
    const root = makeFixtureRoot({ matrix });
    const result = runGenerate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "matrix: vault.correctness owner does not exist: owners/deleted-owner.mjs"
    );
  });

  test("exits non-zero on e2e evidence that belongs to no matrix cell", () => {
    const root = makeFixtureRoot();
    writeJson(root, "e2e/orphan.json", {
      owner: "owners/orphan-suite.mjs",
      status: "passed",
      lane: "e2e",
      capturedAt: CAPTURED_AT,
    });
    const result = runGenerate(root, [
      "--e2e",
      path.join(root, "e2e"),
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unmapped evidence: owners/orphan-suite.mjs"
    );
    expect(result.summary.unmappedEvidence).toBe(1);
  });

  test("exits non-zero on nightly when a declared owner produced no evidence", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root, ["--scope", "nightly"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `declared owner produced no evidence key: ${OWNER}`
    );
  });

  test("exits non-zero on nightly while any cell is still grey", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root, ["--scope", "nightly"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nightly zero-grey contract: 1 cell(s) have no evidence"
    );
  });

  test("exits non-zero when a CI job failed but no evidence records a failure", () => {
    const root = makeFixtureRoot();
    const vitestPath = writeJson(root, "in/vitest.json", vitestReport());
    writeJson(root, "in/job-conclusions.json", { unit: { result: "failure" } });
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
      "--job-conclusions",
      path.join(root, "in/job-conclusions.json"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("job reconciliation:");
    expect(result.summary.silentAllClear).toBe(true);
    expect(result.summary.failedJobs).toEqual(["unit"]);
  });

  test("exits non-zero when grey cells rose against durable history", () => {
    const root = makeFixtureRoot();
    writeJson(root, "history/index.json", {
      entries: [
        {
          slug: "2026-06-01",
          summary: { cellsMissing: 0, missingCellIds: [], failedCellIds: [] },
        },
      ],
    });
    const result = runGenerate(root, ["--history", path.join(root, "history")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cellsMissing rose: prior=0 current=1");
    expect(result.summary.cellsMissingRose).toBe(true);
  });

  test("the main slot reports the grey-cell rise without failing the run", () => {
    const root = makeFixtureRoot();
    writeJson(root, "history/index.json", {
      entries: [
        {
          slug: "2026-06-01",
          summary: { cellsMissing: 0, missingCellIds: [], failedCellIds: [] },
        },
      ],
    });
    const result = runGenerate(root, [
      "--scope",
      "main",
      "--history",
      path.join(root, "history"),
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("cellsMissing rose:");
    expect(result.summary.cellsMissingRose).toBe(true);
  });

  test("exits non-zero on nightly for a cell that regressed to grey", () => {
    const root = makeFixtureRoot();
    writeJson(root, "history/index.json", {
      entries: [
        {
          slug: "2026-06-01",
          summary: { cellsMissing: 1, missingCellIds: [], failedCellIds: [] },
        },
      ],
    });
    const result = runGenerate(root, [
      "--scope",
      "nightly",
      "--history",
      path.join(root, "history"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `new cell regressions: missing=[${CELL_ID}]`
    );
    expect(result.summary.newMissingCellIds).toEqual([CELL_ID]);
  });
});

describe("coverage against floors", () => {
  test("names the scope that sits below its line floor", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      path.join(root, "tests/coverage-floors.json"),
      `${JSON.stringify({ "packages/vault/**": { lines: 80, branches: 70 } })}\n`
    );
    const coveragePath = writeJson(root, "in/coverage.json", {
      "packages/vault/src/a.ts": {
        lines: { total: 100, covered: 50 },
        branches: { total: 10, covered: 9 },
      },
    });
    const vitestPath = writeJson(root, "in/vitest.json", vitestReport());
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
      "--coverage",
      coveragePath,
    ]);
    expect(result.summary.coverageBelowFloor).toContain("packages/vault/**");
    expect(result.summary.floorSeries["coverage:packages/vault/**:lines"]).toBe(
      50
    );
  });

  test("does not flag a scope that meets both of its floors", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      path.join(root, "tests/coverage-floors.json"),
      `${JSON.stringify({ "packages/vault/**": { lines: 40, branches: 70 } })}\n`
    );
    const coveragePath = writeJson(root, "in/coverage.json", {
      "packages/vault/src/a.ts": {
        lines: { total: 100, covered: 50 },
        branches: { total: 10, covered: 9 },
      },
    });
    const vitestPath = writeJson(root, "in/vitest.json", vitestReport());
    const result = runGenerate(root, [
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
      "--coverage",
      coveragePath,
    ]);
    expect(result.summary.coverageBelowFloor).toEqual([]);
  });

  test("reports a floor scope with no coverage data as absent, not as met", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      path.join(root, "tests/coverage-floors.json"),
      `${JSON.stringify({ "packages/ghost/**": { lines: 80 } })}\n`
    );
    const result = runGenerate(root);
    expect(
      result.summary.floorSeries["coverage:packages/ghost/**:lines"]
    ).toBeNull();
  });
});

describe("perf and scale trends", () => {
  test("carries a lane measurement into the durable series", () => {
    const root = makeFixtureRoot();
    writeJson(root, "perf/vault-write.json", {
      owner: OWNER,
      status: "passed",
      lane: "perf",
      capturedAt: CAPTURED_AT,
      measurements: [{ name: "wall clock", unit: "ms", value: 1234 }],
    });
    const result = runGenerate(root, [
      "--perf",
      path.join(root, "perf"),
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.status).toBe(0);
    const series = Object.values(result.summary.laneSeries);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ value: 1234, unit: "ms" });
  });

  test("renders the empty-lane notice rather than an invented trend", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root);
    expect(result.summary.laneSeries).toEqual({});
    expect(result.html).toContain("Perf and scale results are missing");
  });
});
