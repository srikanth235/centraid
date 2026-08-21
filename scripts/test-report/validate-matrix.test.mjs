import path from "node:path";

import { describe, expect, test } from "vitest";

import { fireRevisitTrigger, validateMatrix } from "./validate-matrix.mjs";

/** A file that certainly exists, used wherever the fixture needs a real path. */
const REAL_FILE = "packages/vault/package.json";
const BUNDLED_APPS = [
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
const CANONICAL_STATES = [
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

function baseMatrix(overrides = {}) {
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

describe("validateMatrix", () => {
  test("accepts a minimal well-formed matrix", async () => {
    const { errors } = await validateMatrix(baseMatrix(), {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(errors).toEqual([]);
  });

  test("rejects missing cell-owner mapping", async () => {
    const matrix = baseMatrix();
    delete matrix.cellOwners["vault.correctness"];
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("no explicit cell-owner"))).toBe(true);
  });

  test("rejects skip cells without notes", async () => {
    const matrix = baseMatrix({ notes: {} });
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some(
        (e) => e.includes("vault.skipdim") && e.includes("no matrix.notes")
      )
    ).toBe(true);
  });

  test("rejects unknown surface on a flow", async () => {
    const matrix = baseMatrix();
    matrix.flows[0].surface = "not-a-surface";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("unknown surface"))).toBe(true);
  });

  test("rejects invalid assessment status", async () => {
    const matrix = baseMatrix();
    matrix.surfaces[0].assessment.correctness = "maybe";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) => e.includes("invalid or missing assessment"))
    ).toBe(true);
  });

  test("SABOTAGE: rejects an app-engine pass that does not point at its canonical gate", async () => {
    const matrix = baseMatrix();
    matrix.appEngines.apps[0].engines.core.flow = "not-the-engine-gate";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((error) =>
        error.includes("agenda.core must reference real gate vault-core-flow")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a structural exclusion without the seat-doctrine citation", async () => {
    const matrix = baseMatrix();
    matrix.appEngines.apps[0].engines.core = {
      status: "skip",
      reason: "Structurally unavailable.",
      citation: "README.md",
    };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((error) =>
        error.includes(
          "agenda.core skip must cite docs/blueprint-seats.md#engine-contracts"
        )
      )
    ).toBe(true);
  });

  test("warns (does not fail) when minimumTests is omitted unless required", async () => {
    const matrix = baseMatrix();
    delete matrix.flows[0].minimumTests;
    const { errors, warnings = [] } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
      warnMissingMinimumTests: true,
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("minimumTests"))).toBe(true);
  });

  // #656 Layer 1E — a partial cell is standing debt; it must name a live issue.
  test("rejects a partial cell that cites no open tracking issue", async () => {
    const matrix = baseMatrix();
    matrix.surfaces[0].assessment.correctness = "partial";
    matrix.notes["vault.correctness"] = "Missing the negative cases (#470).";
    matrix.trackingIssues = {
      ...matrix.trackingIssues,
      470: { url: "https://example.test/470", state: "closed" },
    };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("cites no open tracking issue"))).toBe(
      true
    );

    matrix.trackingIssues[656] = {
      url: "https://example.test/656",
      state: "open",
    };
    matrix.notes["vault.correctness"] =
      "Missing the negative cases (#470). Tracked under #656.";
    const fixed = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(fixed.errors).toEqual([]);
  });

  test("rejects a note citing an issue that is not in the ledger", async () => {
    const matrix = baseMatrix();
    matrix.notes["vault.skipdim"] = "deliberate skip note (#4242)";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("unregistered issue #4242"))).toBe(
      true
    );
  });

  test("rejects a revisit trigger on a cell that is no longer skip", async () => {
    const matrix = baseMatrix();
    matrix.revisitTriggers = {
      "vault.correctness": { glob: "packages/**/*.ts", trackingIssue: 656 },
    };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) => e.includes("is not a skip cell; remove the trigger"))
    ).toBe(true);
  });
});

describe("fireRevisitTrigger", () => {
  test("a glob that matches nothing is itself the failure", async () => {
    const fired = await fireRevisitTrigger(
      { glob: "packages/**/migrations/**/*", trackingIssue: 656 },
      { cwd: path.join(import.meta.dirname, "..", "..") }
    );
    expect(fired.error).toContain("matches no file");
  });

  test("contains turns existence into a content tripwire", async () => {
    const cwd = path.join(import.meta.dirname, "..", "..");
    const glob = "scripts/test-report/matrix-grades.mjs";
    const quiet = await fireRevisitTrigger(
      { glob, contains: "THIS_MARKER_DOES_NOT_EXIST", trackingIssue: 656 },
      { cwd }
    );
    expect(quiet).toEqual({});
    const fired = await fireRevisitTrigger(
      { glob, contains: "computeCellGrade", trackingIssue: 656 },
      { cwd }
    );
    expect(fired.match).toBe(glob);
  });
});

/**
 * #839 Wave 0 — the app-shaped axes (gaps G6, G7, G16). Each case is the
 * SABOTAGE of one closure rule: the grids are total (a cell may not go
 * missing), closed against disk (the app axis is what is bundled, the state
 * partition is what the manifest designs), and every citation is followable.
 */
describe("app axes: seats, grid B, grid D, engines, consent", () => {
  test("accepts the well-formed axes", async () => {
    const { errors } = await validateMatrix(baseMatrix(), {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(errors).toEqual([]);
  });

  test("SABOTAGE: rejects a seat registry that is not the three seats", async () => {
    const matrix = baseMatrix();
    matrix.seats = matrix.seats.filter((seat) => seat.id !== "custodian");
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("matrix seats must be exactly"))).toBe(
      true
    );
  });

  test("SABOTAGE: rejects a seat doctrine anchor no heading offers", async () => {
    const matrix = baseMatrix();
    matrix.seats[0].doctrine = "docs/blueprint-seats.md#no-such-heading";
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) => e.includes("citation anchor does not exist"))
    ).toBe(true);
  });

  test("SABOTAGE: rejects an appSeats app set that is not the bundled apps", async () => {
    const matrix = baseMatrix();
    matrix.appSeats.apps.pop();
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) =>
        e.includes("appSeats app registry must exactly match bundled apps")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a missing seat cell — absence is not expressible", async () => {
    const matrix = baseMatrix();
    delete matrix.appSeats.apps[0].seats.viewer;
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors).toContain("appSeats agenda.viewer is missing");
  });

  test("SABOTAGE: rejects a seat gap that cites no open tracking issue", async () => {
    const matrix = baseMatrix();
    matrix.appSeats.apps[0].seats.origin = {
      status: "gap",
      trackingIssue: "4242",
    };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some(
        (e) =>
          e.includes("appSeats agenda.origin") &&
          e.includes("cites no open tracking issue")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an owned seat cell whose journey does not exist", async () => {
    const matrix = baseMatrix();
    matrix.appSeats.apps[0].seats.origin = {
      status: "owned",
      owner: "tests/agent-e2e-mobile/flows/does-not-exist.mjs",
      tier: "e2e",
    };
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some(
        (e) =>
          e.includes("appSeats agenda.origin owner does not exist") &&
          e.includes("does-not-exist.mjs")
      )
    ).toBe(true);
  });

  test("a seat skip may cite the ruling that held the interface, but only a registered one", async () => {
    const matrix = baseMatrix();
    const skip = (citation) => ({
      status: "skip",
      reason: "Tally's interface is held.",
      citation,
    });
    matrix.appSeats.apps[6].seats.origin = skip("#4242");
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) => e.includes("skip cites unregistered issue #4242"))
    ).toBe(true);

    matrix.appSeats.apps[6].seats.origin = skip("839");
    const unreferenced = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      unreferenced.errors.some((e) =>
        e.includes("citation is not a doc#anchor")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a missing designed-state cell", async () => {
    const matrix = baseMatrix();
    delete matrix.appStates.apps[0].states.conflict;
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors).toContain("appStates agenda.conflict is missing");
  });

  test("SABOTAGE: rejects a state grid that does not mirror app.json#states", async () => {
    const matrix = baseMatrix();
    matrix.appStates.apps[0].states.conflict = { status: "excluded" };
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some(
        (e) =>
          e.includes("appStates agenda.conflict is excluded") &&
          e.includes("mirror app.json#states")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a state column set the manifests do not declare", async () => {
    const matrix = baseMatrix();
    matrix.appStates.states.push({ id: "invented", label: "Invented" });
    for (const app of matrix.appStates.apps)
      app.states.invented = { status: "gap" };
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) =>
        e.includes("must cover exactly its manifest partition")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an owned state cell whose proof does not exist", async () => {
    const matrix = baseMatrix();
    matrix.appStates.apps[0].states.dayone = {
      status: "owned",
      owner: "packages/blueprints/apps/agenda/no-such.test.ts",
    };
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) =>
        e.includes("appStates agenda.dayone owner does not exist")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an engine registry source path that is dead", async () => {
    const matrix = baseMatrix();
    matrix.engineRegistry[0].source = ["packages/vault/src/gone.ts"];
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) =>
        e.includes("engineRegistry core source does not exist")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an unknown property flow or mutation seed", async () => {
    const matrix = baseMatrix();
    matrix.engineRegistry[0].propertyFlow = "not-a-flow";
    matrix.engineRegistry[0].mutationSeed = "packages/not-a-seed";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) => e.includes("unknown property flow not-a-flow"))
    ).toBe(true);
    expect(
      errors.some((e) =>
        e.includes("unknown mutation seed packages/not-a-seed")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an engine that claims a grid-C column it does not have", async () => {
    const matrix = baseMatrix();
    matrix.engineRegistry.push({
      id: "invented",
      label: "Invented",
      source: [REAL_FILE],
      propertyFlow: null,
      mutationSeed: null,
      appEngineColumn: true,
    });
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) =>
        e.includes("appEngineColumn set must equal appEngines columns")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a consent ledger that is not eight layers", async () => {
    const matrix = baseMatrix();
    matrix.consentLedger.pop();
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some((e) =>
        e.includes("must declare exactly eight permission layers")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a consent layer with neither adversary nor open issue", async () => {
    const matrix = baseMatrix();
    matrix.consentLedger[0].adversary = { owner: null, flow: null };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some(
        (e) =>
          e.includes("consentLedger layer-0") &&
          e.includes("no adversary and cites no open tracking issue")
      )
    ).toBe(true);

    matrix.consentLedger[0].adversary = {
      owner: null,
      flow: null,
      trackingIssue: "839",
    };
    const tracked = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      tracked.errors.some((e) => e.includes("consentLedger layer-0"))
    ).toBe(false);
  });

  test("SABOTAGE: rejects a consent layer enforcement path that does not exist", async () => {
    const matrix = baseMatrix();
    matrix.consentLedger[1].enforcement = ["packages/vault/src/gone.ts"];
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
    });
    expect(
      errors.some((e) =>
        e.includes("consentLedger layer-1 enforcement does not exist")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a consent note citing an unregistered issue", async () => {
    const matrix = baseMatrix();
    matrix.consentLedger[2].note = "Tracked under #4242.";
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      errors.some(
        (e) =>
          e.includes("consentLedger layer-2") &&
          e.includes("unregistered issue #4242")
      )
    ).toBe(true);
  });
});
