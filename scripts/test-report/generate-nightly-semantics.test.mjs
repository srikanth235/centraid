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
const CAPTURED_AT = "2026-01-01T00:00:00.000Z";
const CAPTURED_MS = Date.parse(CAPTURED_AT);

const OWNER = "owners/unit-owner.mjs";
const CELL_ID = "vault:correctness";

function baseMatrix() {
  return {
    version: 1,
    notes: {},
    workspaceSurfaces: {},
    trackingIssues: {
      839: { url: "https://example.invalid/839", state: "open" },
    },
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
    // #839 Wave 0 — the app-shaped axes, kept minimal: this file's subject is
    // nightly cell semantics, and the app grids deliberately contribute
    // nothing to cell state.
    seats: ["origin", "custodian", "viewer"].map((id) => ({
      id,
      label: id,
      doctrine: "docs/blueprint-seats.md#the-three-seats",
    })),
    appSeats: { apps: [] },
    appStates: {
      trackingIssue: "839",
      states: [{ id: "dayone", label: "Day one" }],
      apps: [],
    },
    engineRegistry: [
      {
        id: "engine",
        label: "Engine",
        source: [OWNER],
        propertyFlow: null,
        mutationSeed: null,
        appEngineColumn: false,
      },
    ],
    consentLedger: Array.from({ length: 8 }, (_, index) => ({
      id: `layer-${index}`,
      label: `Layer ${index}`,
      enforcement: [OWNER],
      refusalGrammar: "refuses in words",
      adversary: { owner: OWNER, flow: null },
      seats: ["origin"],
      note: "fixture layer",
    })),
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
  // `validate-matrix.mjs` reads the mutation seed catalog to check every
  // engine-registry row's declared adversary seed.
  cpSync(
    path.join(realRoot, "scripts/mutation"),
    path.join(root, "scripts/mutation"),
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
    "## Engine contracts\n\n## The three seats\n"
  );
  const fixtureMatrix = options.matrix ?? baseMatrix();
  for (const app of fixtureMatrix.appEngines?.apps ?? []) {
    const appRoot = path.join(root, "packages/blueprints/apps", app.id);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      path.join(appRoot, "app.json"),
      `${JSON.stringify(
        {
          states: {
            designed: (fixtureMatrix.appStates?.states ?? []).map(
              (state) => state.id
            ),
            excluded: [],
          },
        },
        null,
        2
      )}\n`
    );
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

describe("accessibility has no expected-grey escape (#791)", () => {
  const ACCESSIBILITY_OWNER = "scripts/accessibility-contract.test.mjs";

  function accessibilityMatrix() {
    return {
      version: 1,
      notes: {
        "vault-core.accessibility":
          "No accessibility evidence lane exists yet; the keyboard/screen-reader journey is unowned. Tracked under #781.",
      },
      trackingIssues: {
        781: {
          url: "https://github.com/srikanth235/centraid/issues/781",
          state: "open",
        },
      },
      workspaceSurfaces: {},
      dimensions: [
        { id: "accessibility", label: "Accessibility", lane: "per-pr" },
      ],
      surfaces: [
        {
          id: "vault-core",
          label: "Vault",
          assessment: { accessibility: "partial" },
        },
      ],
      cellOwners: {
        "vault-core.accessibility": {
          owner: ACCESSIBILITY_OWNER,
          tier: "accessibility",
        },
      },
      flows: [],
      appEngines: {
        engines: [],
        apps: [],
        seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
      },
    };
  }

  function accessibilityRoot() {
    const root = makeFixtureRoot({ matrix: accessibilityMatrix() });
    writeFileSync(
      path.join(root, ACCESSIBILITY_OWNER),
      "test('static accessibility contract', () => {});\n"
    );
    return root;
  }

  test("a static accessibility owner with no evidence is nightly red", () => {
    const root = accessibilityRoot();
    const result = runGenerate(root, ["--scope", "nightly"]);
    expect(result.status).toBe(1);
    expect(result.summary.cellsExpectedGrey).toBe(0);
    expect(result.summary.cellsMissing).toBe(1);
    expect(result.stderr).toContain(
      `declared owner produced no evidence key: ${ACCESSIBILITY_OWNER}`
    );
  });

  test("a started accessibility lane names a silent owner", () => {
    const root = accessibilityRoot();
    writeJson(root, "markers/lane-starts.json", {
      accessibility: CAPTURED_AT,
    });
    const result = runGenerate(root, [
      "--scope",
      "nightly",
      "--lane-markers",
      path.join(root, "markers"),
    ]);
    expect(result.status).toBe(1);
    expect(result.summary.cellsExpectedGrey).toBe(0);
    expect(result.summary.cellsOwnerSilent).toBe(1);
    expect(result.stderr).toContain(
      "nightly zero-grey contract: 1 cell(s) have no evidence"
    );
    expect(result.stderr).toContain(
      `declared owner produced no evidence key: ${ACCESSIBILITY_OWNER}`
    );
  });

  test("real failing evidence for a registered cell stays red", () => {
    const root = accessibilityRoot();
    const vitestPath = writeJson(root, "in/vitest.json", {
      startTime: CAPTURED_MS,
      testResults: [
        {
          name: ACCESSIBILITY_OWNER,
          status: "failed",
          startTime: CAPTURED_MS,
          endTime: CAPTURED_MS,
          assertionResults: [],
        },
      ],
    });
    const result = runGenerate(root, [
      "--scope",
      "nightly",
      "--vitest",
      vitestPath,
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.summary.cellsExpectedGrey).toBe(0);
    expect(result.summary.cellsFailed).toBe(1);
    expect(result.summary.failedCellIds).toStrictEqual([
      "vault-core:accessibility",
    ]);
  });

  test("an UNregistered grey cell still fails the zero-grey contract", () => {
    // baseMatrix's vault:correctness is not on any expected-grey registration.
    const root = makeFixtureRoot();
    const result = runGenerate(root, ["--scope", "nightly"]);
    expect(result.status).toBe(1);
    expect(result.summary.cellsExpectedGrey).toBe(0);
    expect(result.stderr).toContain(
      "nightly zero-grey contract: 1 cell(s) have no evidence"
    );
  });
});

describe("platform-keyed lane series (#781)", () => {
  test("keeps iOS and Android scale results as distinct series", () => {
    const root = makeFixtureRoot();
    writeJson(root, "scale/cold-start-ios.json", {
      owner: OWNER,
      status: "passed",
      lane: "scale",
      platform: "ios",
      capturedAt: CAPTURED_AT,
      measurements: [{ name: "median cold start", unit: "ms", value: 1200 }],
    });
    writeJson(root, "scale/cold-start-android.json", {
      owner: OWNER,
      status: "passed",
      lane: "scale",
      platform: "android",
      capturedAt: CAPTURED_AT,
      measurements: [{ name: "median cold start", unit: "ms", value: 3400 }],
    });
    const result = runGenerate(root, [
      "--scale",
      path.join(root, "scale"),
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    const series = Object.values(result.summary.laneSeries);
    expect(series).toHaveLength(2);
    const values = series.map((entry) => entry.value).sort((a, b) => a - b);
    expect(values).toStrictEqual([1200, 3400]);
  });

  test("a red platform is never masked by a green one on the same owner", () => {
    const root = makeFixtureRoot();
    // Filename order: android sorts before ios, so the naive last-write-wins
    // map used to keep ios (passed) and hide android (failed).
    writeJson(root, "e2e/home-loads-android.json", {
      owner: OWNER,
      status: "failed",
      lane: "e2e",
      platform: "android",
      capturedAt: CAPTURED_AT,
      measurements: [{ name: "wall clock", unit: "ms", value: 100 }],
    });
    writeJson(root, "e2e/home-loads-ios.json", {
      owner: OWNER,
      status: "passed",
      lane: "e2e",
      platform: "ios",
      capturedAt: CAPTURED_AT,
      measurements: [{ name: "wall clock", unit: "ms", value: 90 }],
    });
    const result = runGenerate(root, [
      "--e2e",
      path.join(root, "e2e"),
      "--max-age-hours",
      FRESH_WINDOW_HOURS,
    ]);
    expect(result.summary.cellsFailed).toBe(1);
    expect(result.summary.failedCellIds).toStrictEqual([CELL_ID]);
  });
});
