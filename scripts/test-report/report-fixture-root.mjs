import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

/**
 * The synthetic-root harness shared by the `generate.mjs` honesty suites
 * (`generate.test.mjs`, `generate-app-grids.test.mjs`).
 *
 * `generate.mjs` is a top-level side-effecting main with no exported seam, and
 * it derives the repo root from `import.meta.dirname`. Each case therefore
 * copies `scripts/test-report/` into a **synthetic root** and drives the real
 * script as a subprocess against fixture evidence. Nothing reads the live
 * matrix, floors, or artifacts, so a sibling agent editing those files cannot
 * change these results.
 *
 * Determinism: every timestamp is a literal, and freshness is pinned by
 * `--max-age-hours` rather than by the wall clock. `FRESH_WINDOW_HOURS` is a
 * century-wide window (so a literal timestamp is never aged out) and
 * `STALE_AT` is far enough in the past that the default 36-hour rule always
 * classifies it stale.
 */

const realRoot = path.resolve(import.meta.dirname, "../..");
/** Wide enough that a literal timestamp never ages out of the window. */
export const FRESH_WINDOW_HOURS = "1000000";
/** Long past — always older than the 36-hour default evidence window. */
export const STALE_AT = "2020-03-01T00:00:00.000Z";
export const CAPTURED_AT = "2026-01-01T00:00:00.000Z";
export const CAPTURED_MS = Date.parse(CAPTURED_AT);

export const OWNER = "owners/unit-owner.mjs";
export const CELL_ID = "vault:correctness";

/** The eight consent layers the ledger must always carry, minimally shaped. */
function consentLedgerFixture() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `layer-${index}`,
    label: `Layer ${index}`,
    enforcement: [OWNER],
    refusalGrammar: "refuses in words",
    adversary: { owner: OWNER, flow: null },
    seats: ["origin"],
    note: "fixture layer",
  }));
}

/**
 * Grid B and grid D rows for a fixture whose synthetic root bundles `appIds`.
 * Both grids are total and closed, so a fixture that bundles an app owes it a
 * cell for every seat and every declared state.
 * @param {string[]} appIds Bundled blueprint ids.
 * @param {string[]} [stateIds] Designed states the fixture manifests declare.
 */
export function appAxesFor(appIds, stateIds = ["dayone"]) {
  return {
    appSeats: {
      apps: appIds.map((id) => ({
        id,
        seats: Object.fromEntries(
          ["origin", "custodian", "viewer"].map((seat) => [
            seat,
            { status: "gap", trackingIssue: "839" },
          ])
        ),
      })),
    },
    appStates: {
      trackingIssue: "839",
      states: stateIds.map((id) => ({ id, label: id })),
      apps: appIds.map((id) => ({
        id,
        states: Object.fromEntries(
          stateIds.map((state) => [state, { status: "gap" }])
        ),
      })),
    },
  };
}

export function baseMatrix() {
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
    // #839 Wave 0 — the app-shaped axes. The fixture keeps the app rows empty
    // (the synthetic root bundles no blueprints) so each grid's density rule
    // is satisfied trivially and the grids still render.
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
    consentLedger: consentLedgerFixture(),
  };
}

/**
 * Build a synthetic repo root containing a copy of the generator and the
 * root-relative files it reads directly (floors are read from `root/tests/`).
 * @param {{ matrix?: object, appManifestStates?: object }} [options] Overrides.
 */
export function makeFixtureRoot(options = {}) {
  const root = tempDirSync("centraid-test-report-");
  cpSync(
    path.join(realRoot, "scripts/test-report"),
    path.join(root, "scripts/test-report"),
    { recursive: true }
  );
  // `validate-matrix.mjs` reads the mutation seed catalog to check every
  // engine-registry row's declared adversary seed, so the synthetic root needs
  // it beside the generator.
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
  // Every bundled app carries the states block grid D mirrors (#839 Wave 0),
  // so the synthetic manifests carry one too.
  const manifestStates = options.appManifestStates ?? {
    designed: (fixtureMatrix.appStates?.states ?? []).map((state) => state.id),
    excluded: [],
  };
  for (const app of fixtureMatrix.appEngines?.apps ?? []) {
    const appRoot = path.join(root, "packages/blueprints/apps", app.id);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(
      path.join(appRoot, "app.json"),
      `${JSON.stringify({ states: manifestStates }, null, 2)}\n`
    );
  }
  writeFileSync(
    path.join(root, "matrix.json"),
    `${JSON.stringify(fixtureMatrix, null, 2)}\n`
  );
  return root;
}

/** Write a JSON fixture under the synthetic root and return its path. */
export function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

/** A single passing vitest file result for OWNER, captured at `atMs`. */
export function vitestReport(atMs = CAPTURED_MS, status = "passed") {
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
export function runGenerate(root, args = []) {
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
