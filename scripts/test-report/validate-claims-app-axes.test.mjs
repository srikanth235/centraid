import { describe, expect, test } from "vitest";

import { baseMatrix, REAL_FILE } from "./claims-fixture.mjs";
import { validateAppAxes } from "./validate-app-axes.mjs";

async function validateMatrix(claims, options = {}) {
  const flowIds = new Set(
    (claims.flows ?? []).map((flow) => flow.id).concat(["vault-core-flow"])
  );
  return { errors: await validateAppAxes(claims, options, flowIds) };
}

describe("app axes: seats, grid B, grid D, engines, consent", () => {
  test("accepts the well-formed axes", async () => {
    const { errors } = await validateMatrix(baseMatrix(), {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
      checkReportRegistries: false,
    });
    expect(
      errors.some((e) =>
        e.includes("appStates agenda.dayone owner does not exist")
      )
    ).toBe(true);
  });

  test("a designed state may be HELD, but only against a registered ruling", async () => {
    const matrix = baseMatrix();
    const held = (citation) => ({
      status: "held",
      ...(citation === undefined ? {} : { citation }),
    });
    matrix.appStates.apps[6].states.dayone = held("#839");
    const accepted = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      accepted.errors.some((e) => e.includes("appStates tally.dayone"))
    ).toBe(false);

    matrix.appStates.apps[6].states.dayone = held();
    const uncited = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      uncited.errors.some(
        (e) =>
          e.includes("appStates tally.dayone") &&
          e.includes("is held but cites no issue")
      )
    ).toBe(true);

    matrix.appStates.apps[6].states.dayone = held("#4242");
    const unregistered = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(
      unregistered.errors.some((e) =>
        e.includes("held cites unregistered issue #4242")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects an engine registry source path that is dead", async () => {
    const matrix = baseMatrix();
    matrix.engineRegistry[0].source = ["packages/vault/src/gone.ts"];
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
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
      checkReportRegistries: false,
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
