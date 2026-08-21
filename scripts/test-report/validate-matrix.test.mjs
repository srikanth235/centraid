import path from "node:path";

import { describe, expect, test } from "vitest";

import { baseMatrix } from "./matrix-fixture.mjs";
import { fireRevisitTrigger, validateMatrix } from "./validate-matrix.mjs";

describe("validateMatrix", () => {
  test("accepts a minimal well-formed matrix", async () => {
    const { errors } = await validateMatrix(baseMatrix(), {
      checkEnvGates: false,
      checkWorkspaceCompleteness: false,
      checkReportRegistries: false,
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
