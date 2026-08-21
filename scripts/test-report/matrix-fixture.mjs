/**
 * The shared synthetic matrix used by the `validate-matrix.mjs` unit suites.
 *
 * `validate-matrix.test.mjs` (the core law) and
 * `validate-matrix-app-axes.test.mjs` (the #839 app-shaped axes) both sabotage
 * one rule at a time against the SAME well-formed baseline, so the baseline
 * lives here rather than being copied into each file.
 */

/** A file that certainly exists, used wherever the fixture needs a real path. */
export const REAL_FILE = "packages/vault/package.json";

export const BUNDLED_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
];

/**
 * The canonical designed states, mirrored from every bundled `app.json#states`
 * (#839 Wave 0). The fixture must agree with the real manifests because the
 * mirror check reads them off disk.
 */
export const CANONICAL_STATES = [
  "dayone",
  "pending",
  "offline",
  "stale",
  "conflict",
  "parked",
  "denied",
];

/** Grid B: every bundled app owes a cell for each of the three seats. */
function appSeatsFixture() {
  return {
    apps: BUNDLED_APPS.map((id) => ({
      id,
      seats: Object.fromEntries(
        ["origin", "custodian", "viewer"].map((seat) => [
          seat,
          { status: "gap", trackingIssue: "839" },
        ])
      ),
    })),
  };
}

/** Grid D: every bundled app owes a cell for each canonical designed state. */
function appStatesFixture() {
  return {
    trackingIssue: "839",
    states: CANONICAL_STATES.map((id) => ({ id, label: id })),
    apps: BUNDLED_APPS.map((id) => ({
      id,
      states: Object.fromEntries(
        CANONICAL_STATES.map((state) => [state, { status: "gap" }])
      ),
    })),
  };
}

export function baseMatrix(overrides = {}) {
  const appEngines = {
    seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
    engines: [{ id: "core", label: "Core", flow: "vault-core-flow" }],
    apps: BUNDLED_APPS.map((id) => ({
      id,
      engines: { core: { status: "pass", flow: "vault-core-flow" } },
    })),
  };
  return {
    version: 1,
    trackingIssues: {
      839: {
        url: "https://github.com/srikanth235/centraid/issues/839",
        state: "open",
      },
    },
    seats: ["origin", "custodian", "viewer"].map((id) => ({
      id,
      label: id,
      doctrine: "docs/blueprint-seats.md#the-three-seats",
    })),
    appSeats: appSeatsFixture(),
    appStates: appStatesFixture(),
    engineRegistry: [
      {
        id: "core",
        label: "Core",
        source: [REAL_FILE],
        propertyFlow: "vault-core-flow",
        mutationSeed: "packages/vault",
        appEngineColumn: true,
      },
    ],
    consentLedger: Array.from({ length: 8 }, (_, index) => ({
      id: `layer-${index}`,
      label: `Layer ${index}`,
      enforcement: [REAL_FILE],
      refusalGrammar: "refuses in words",
      adversary: { owner: REAL_FILE, flow: null },
      seats: ["origin"],
      note: "fixture layer",
    })),
    legend: { solid: "s", partial: "p", gap: "g", skip: "k" },
    notes: {
      "vault.skipdim": "deliberate skip note",
    },
    dimensions: [
      { id: "correctness", label: "Correctness", lane: "unit" },
      { id: "skipdim", label: "Skip dim", lane: "unit" },
    ],
    surfaces: [
      {
        id: "vault",
        label: "Vault",
        assessment: { correctness: "solid", skipdim: "skip" },
      },
    ],
    cellOwners: {
      "vault.correctness": {
        owner: "packages/vault/package.json",
        tier: "unit",
      },
      "vault.skipdim": null,
    },
    flows: [
      {
        id: "vault-core-flow",
        name: "Vault core",
        surface: "vault",
        dimension: "correctness",
        tier: "unit",
        owner: "packages/vault/package.json",
        minimumTests: 0,
      },
    ],
    appEngines,
    ...overrides,
  };
}
