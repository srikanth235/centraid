import { describe, expect, test } from "vitest";

import { baseMatrix, REAL_FILE } from "./claims-fixture.mjs";
import { validateAppAxes } from "./validate-app-axes.mjs";

/**
 * The app-axis half of the claims law, in the shape these suites were written
 * against. #915 retired `validate-matrix.mjs`; `validateAppAxes` is the rule
 * set these cases actually exercise, and the fixture declares its own flow ids
 * rather than inheriting a repo-wide set.
 */
async function validateMatrix(claims, options = {}) {
  const flowIds = new Set(
    (claims.flows ?? []).map((flow) => flow.id).concat(["vault-core-flow"])
  );
  return { errors: await validateAppAxes(claims, options, flowIds) };
}

describe("appScenarios ledger", () => {
  test("accepts the well-formed fixture ledger", async () => {
    const { errors } = await validateMatrix(baseMatrix(), {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
    });
    expect(errors).toEqual([]);
  });

  test("SABOTAGE: rejects a missing ledger", async () => {
    const matrix = baseMatrix();
    delete matrix.appScenarios;
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors).toContain("matrix has no appScenarios ledger");
  });

  test("SABOTAGE: rejects an app set that is not the bundled apps", async () => {
    const matrix = baseMatrix();
    matrix.appScenarios.apps.pop();
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
    });
    expect(
      errors.some((e) =>
        e.includes("appScenarios app registry must exactly match bundled apps")
      )
    ).toBe(true);
  });

  test("SABOTAGE: rejects a product-bug without a note", async () => {
    const matrix = baseMatrix();
    matrix.appScenarios.apps[0].scenarios[0] = {
      id: "broken",
      label: "a write that loses data",
      layer: "unit",
      status: "product-bug",
      trackingIssue: "839",
    };
    const { errors } = await validateMatrix(matrix, {
      checkFiles: false,
      checkEnvGates: false,
    });
    expect(errors.some((e) => e.includes("product-bug but has no note"))).toBe(
      true
    );
  });

  test("SABOTAGE: rejects an owned row whose owner does not exist", async () => {
    const matrix = baseMatrix();
    matrix.appScenarios.apps[0].scenarios.push({
      id: "owned-missing",
      label: "owned without a file",
      layer: "unit",
      status: "owned",
      owner: "does-not-exist.test.ts",
    });
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
    });
    expect(errors.some((e) => e.includes("owner does not exist"))).toBe(true);
  });

  test("accepts an owned row that names a real file", async () => {
    const matrix = baseMatrix();
    matrix.appScenarios.apps[0].scenarios.push({
      id: "owned-real",
      label: "owned with a file",
      layer: "unit",
      status: "owned",
      owner: REAL_FILE,
    });
    const { errors } = await validateMatrix(matrix, {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
    });
    expect(errors).toEqual([]);
  });
});
