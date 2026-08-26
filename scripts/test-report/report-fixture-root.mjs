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

/** The synthetic join-law suite grid E derives its two rows from (#839 W5). */
export const JOIN_OWNER = "owners/join-lane.test.mjs";
/** The synthetic Maestro journey grid G derives its single row from. */
export const JOURNEY_OWNER = "tests/agent-e2e-mobile/flows/fixture-flow.mjs";
const JOURNEY_RUNNER = "tests/agent-e2e-mobile/run-fixture-suite.mjs";
const JOURNEY_BUDGET_DOC = "tests/agent-e2e-mobile/flows/fixture-budget.md";

/**
 * The two report-v2 registry blocks (#839 Wave 5) every synthetic root owes.
 * Exported because a second honesty harness
 * (`generate-nightly-semantics.test.mjs`) builds its own matrices and must
 * declare the same lanes against the same files.
 * @returns {{joinLaws: object[], journeys: object}} Grid E and grid G sources.
 */
export function registryBlocks() {
  return { joinLaws: joinLawsFixture(), journeys: journeysFixture() };
}

/**
 * Write the suites, runner and budget doc the registry blocks name. Every
 * synthetic root must call this, because `validate-report-registries.mjs`
 * reads the declarations back out of these files.
 * @param {string} root Synthetic repo root.
 */
export function writeRegistryFiles(root) {
  mkdirSync(path.join(root, "owners"), { recursive: true });
  // Grid E's synthetic suite. The validator counts `test(` declarations here
  // and compares that count against the joinLaws rows, so this file carries
  // exactly as many as `joinLawsFixture` declares.
  writeFileSync(
    path.join(root, JOIN_OWNER),
    [
      'test("the fixture join law holds", () => {});',
      'test("the fixture simulation replays from its seed", () => {});',
      "",
    ].join("\n")
  );
  // Grid G's synthetic suite: one runner whose FLOWS list and BUDGET_MS the
  // validator reads back, one journey, one budget doc.
  mkdirSync(path.join(root, "tests/agent-e2e-mobile/flows"), {
    recursive: true,
  });
  writeFileSync(path.join(root, JOURNEY_OWNER), "// fixture Maestro flow\n");
  writeFileSync(
    path.join(root, JOURNEY_RUNNER),
    [
      'const FLOWS = ["fixture-flow.mjs"];',
      "const BUDGET_MS = 4 * 60_000;",
      "",
    ].join("\n")
  );
  writeFileSync(
    path.join(root, JOURNEY_BUDGET_DOC),
    "# Fixture journey budget\n\nFour minutes, aggregate.\n"
  );
}

/**
 * Grid E's rows. Two laws — one scripted, one simulation — because
 * `validate-report-registries.mjs` requires both halves of the grid to exist,
 * and both are owned by one synthetic suite whose test count matches.
 */
function joinLawsFixture() {
  return [
    {
      id: "fixture-scripted-law",
      label: "Fixture scripted law",
      kind: "scripted",
      lane: "protocol-join",
      owner: JOIN_OWNER,
      testName: "the fixture join law holds",
      flow: null,
      seats: ["origin", "custodian", "viewer"],
      statement:
        "A synthetic scripted join law, so grid E has a row to render.",
    },
    {
      id: "fixture-simulation-law",
      label: "Fixture simulation law",
      kind: "simulation",
      lane: "per-pr",
      owner: JOIN_OWNER,
      testName: "the fixture simulation replays from its seed",
      flow: null,
      seats: ["origin"],
      statement: "A synthetic simulation law, so grid E's second half renders.",
    },
  ];
}

/** Grid G's rows: one budgeted suite over the one synthetic journey. */
function journeysFixture() {
  return {
    trackingIssue: "839",
    suites: [
      {
        id: "fixture",
        label: "Fixture suite",
        runner: JOURNEY_RUNNER,
        budgetDoc: JOURNEY_BUDGET_DOC,
        budgetMinutes: 4,
        flows: [
          {
            id: "fixture-flow",
            label: "Fixture flow",
            owner: JOURNEY_OWNER,
            flow: null,
          },
        ],
      },
    ],
  };
}

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
    appScenarios: {
      trackingIssue: "839",
      layers: [
        { id: "unit", label: "U" },
        { id: "component", label: "C" },
        { id: "journey", label: "E" },
      ],
      apps: appIds.map((id) => ({
        id,
        doc: `docs/apps/${id}-scenarios.md`,
        scenarios: [
          {
            id: "fixture-row",
            label: "fixture scenario",
            layer: "unit",
            status: "gap",
            trackingIssue: "839",
          },
        ],
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
    appScenarios: {
      trackingIssue: "839",
      layers: [
        { id: "unit", label: "U" },
        { id: "component", label: "C" },
        { id: "journey", label: "E" },
      ],
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
    // #839 Wave 5 — the registries grids E and G derive from. Both are pinned
    // to files `makeFixtureRoot` writes, so a fixture cannot claim a lane the
    // synthetic root does not actually contain.
    joinLaws: joinLawsFixture(),
    journeys: journeysFixture(),
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
  // The adversary panel (#839 Wave 5) reads the fuzz target catalog and the
  // committed corpus counts, so the synthetic root carries both. The catalog
  // is plain data — nothing here loads a target's entry module.
  cpSync(path.join(realRoot, "scripts/fuzz"), path.join(root, "scripts/fuzz"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "report-fixture", workspaces: { packages: [] } }, null, 2)}\n`
  );
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "tests/coverage-floors.json"), "{}\n");
  writeFileSync(path.join(root, "tests/mutation-floors.json"), "{}\n");
  mkdirSync(path.join(root, "owners"), { recursive: true });
  writeFileSync(path.join(root, OWNER), "test('owned behaviour', () => {});\n");
  writeRegistryFiles(root);
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(
    path.join(root, "docs/blueprint-seats.md"),
    "## Engine contracts\n\n## The three seats\n"
  );
  const fixtureMatrix = options.matrix ?? baseMatrix();
  mkdirSync(path.join(root, "docs/apps"), { recursive: true });
  for (const app of fixtureMatrix.appScenarios?.apps ?? []) {
    if (!app?.doc) continue;
    const docPath = path.join(root, app.doc);
    mkdirSync(path.dirname(docPath), { recursive: true });
    writeFileSync(docPath, `# ${app.id} scenarios\n\nfixture.\n`);
  }
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
