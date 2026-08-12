import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

/**
 * Honesty-contract tests for the test-health report generator (issue #656
 * Layer 1F).
 *
 * `generate.mjs` is a top-level side-effecting main with no exported seam, and
 * it derives the repo root from `import.meta.dirname`. Each case therefore
 * copies `scripts/test-report/` into a **synthetic root** and drives the real
 * script as a subprocess against fixture evidence. Nothing reads the live
 * matrix, floors, or artifacts, so a sibling agent editing those files cannot
 * change these results.
 *
 * Determinism: every timestamp below is a literal, and freshness is pinned by
 * `--max-age-hours` rather than by the wall clock. `FRESH_WINDOW_HOURS` is a
 * century-wide window (so a literal timestamp is never aged out) and
 * `STALE_AT` is far enough in the past that the default 36-hour rule always
 * classifies it stale.
 */

const realRoot = path.resolve(import.meta.dirname, "../..");
/** Wide enough that a literal timestamp never ages out of the window. */
const FRESH_WINDOW_HOURS = "1000000";
/** Long past — always older than the 36-hour default evidence window. */
const STALE_AT = "2020-03-01T00:00:00.000Z";
const CAPTURED_AT = "2026-01-01T00:00:00.000Z";
const CAPTURED_MS = Date.parse(CAPTURED_AT);

const OWNER = "owners/unit-owner.mjs";
const CELL_ID = "vault:correctness";

function baseMatrix() {
  return {
    version: 1,
    notes: {},
    workspaceSurfaces: {},
    dimensions: [{ id: "correctness", label: "Correctness", lane: "unit" }],
    surfaces: [
      { id: "vault", label: "Vault", assessment: { correctness: "solid" } },
    ],
    cellOwners: { "vault.correctness": { owner: OWNER, tier: "unit" } },
    flows: [],
    appEngines: {
      engines: [],
      apps: [],
      seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
    },
  };
}

/**
 * Build a synthetic repo root containing a copy of the generator and the
 * root-relative files it reads directly (floors are read from `root/tests/`).
 * @param {{ matrix?: object }} [options] Fixture overrides.
 */
function makeFixtureRoot(options = {}) {
  const root = tempDirSync("centraid-test-report-");
  cpSync(
    path.join(realRoot, "scripts/test-report"),
    path.join(root, "scripts/test-report"),
    { recursive: true }
  );
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "report-fixture", workspaces: { packages: [] } }, null, 2)}\n`
  );
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "tests/coverage-floors.json"), "{}\n");
  writeFileSync(path.join(root, "tests/mutation-floors.json"), "{}\n");
  mkdirSync(path.join(root, "owners"), { recursive: true });
  writeFileSync(path.join(root, OWNER), "test('owned behaviour', () => {});\n");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(
    path.join(root, "docs/blueprint-seats.md"),
    "## Engine contracts\n"
  );
  const fixtureMatrix = options.matrix ?? baseMatrix();
  for (const app of fixtureMatrix.appEngines?.apps ?? []) {
    const appRoot = path.join(root, "packages/blueprints/apps", app.id);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(path.join(appRoot, "app.json"), "{}\n");
  }
  writeFileSync(
    path.join(root, "matrix.json"),
    `${JSON.stringify(fixtureMatrix, null, 2)}\n`
  );
  return root;
}

/** Write a JSON fixture under the synthetic root and return its path. */
function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

/** A single passing vitest file result for OWNER, captured at `atMs`. */
function vitestReport(atMs = CAPTURED_MS, status = "passed") {
  return {
    startTime: atMs,
    testResults: [
      {
        name: OWNER,
        status,
        startTime: atMs,
        endTime: atMs,
        assertionResults: [],
      },
    ],
  };
}

/**
 * Run the copied generator against the synthetic root.
 * @param {string} root Synthetic repo root.
 * @param {string[]} [args] extra flags appended after the fixed fixture flags
 */
function runGenerate(root, args = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/test-report/generate.mjs"),
      "--matrix",
      path.join(root, "matrix.json"),
      "--output",
      path.join(root, "dist/index.html"),
      ...args,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env } }
  );
  const summaryPath = path.join(root, "dist/summary.json");
  return {
    ...result,
    summary: JSON.parse(readFileSync(summaryPath, "utf8")),
    html: readFileSync(path.join(root, "dist/index.html"), "utf8"),
  };
}

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
