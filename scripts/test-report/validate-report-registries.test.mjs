import { describe, expect, test } from "vitest";

import {
  declaredTestTitles,
  runnerBudgetMinutes,
  runnerFlowList,
  validateReportRegistries,
} from "./validate-report-registries.mjs";

/**
 * #839 Wave 5 — the derivation locks under grids E and G.
 *
 * Each case sabotages ONE way a hand-maintained lane list rots: a law deleted
 * from its suite, a law added without a declaration, a journey removed from a
 * runner, a budget that drifted from the ceiling the runner enforces, a
 * journey file on disk nobody declares. Every one of them must be an error —
 * because the alternative is a report that renders a shorter grid and calls it
 * progress.
 */

const JOIN_SOURCE = [
  'test("law one holds", async () => {});',
  "test(",
  '  "law two holds",',
  "  async () => {}",
  ");",
].join("\n");

const RUNNER_SOURCE = [
  'const FLOWS = ["a.mjs", "b.mjs"];',
  "const BUDGET_MS = 10 * 60_000;",
].join("\n");

function baseMatrix(overrides = {}) {
  return {
    seats: [
      { id: "origin", label: "Origin" },
      { id: "custodian", label: "Custodian" },
      { id: "viewer", label: "Viewer" },
    ],
    flows: [{ id: "sim-flow", owner: "sim.test.ts" }],
    joinLaws: [
      {
        id: "law-one",
        label: "Law one",
        kind: "scripted",
        lane: "protocol-join",
        owner: "join.test.ts",
        testName: "law one holds",
        flow: null,
        seats: ["origin"],
        statement: "s",
      },
      {
        id: "law-two",
        label: "Law two",
        kind: "simulation",
        lane: "per-pr",
        owner: "join.test.ts",
        testName: "law two holds",
        flow: "sim-flow",
        seats: ["origin"],
        statement: "s",
      },
    ],
    journeys: {
      trackingIssue: "839",
      suites: [
        {
          id: "budgeted",
          label: "Budgeted",
          runner: "run.mjs",
          budgetDoc: "budget.md",
          budgetMinutes: 10,
          flows: [
            { id: "a", label: "A", owner: "flows/a.mjs", flow: null },
            { id: "b", label: "B", owner: "flows/b.mjs", flow: null },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const SOURCES = {
  "join.test.ts": JOIN_SOURCE,
  "sim.test.ts": 'test("sim", () => {});',
  "run.mjs": RUNNER_SOURCE,
  "budget.md": "# Budget\n",
  "flows/a.mjs": "// a\n",
  "flows/b.mjs": "// b\n",
};

function run(matrix, { sources = SOURCES, flowFiles } = {}) {
  return validateReportRegistries(matrix, {
    readSource: async (file) => sources[file] ?? null,
    flowFiles: flowFiles ?? ["flows/a.mjs", "flows/b.mjs"],
  });
}

describe("declaredTestTitles", () => {
  test("reads one-line and wrapped declarations, in file order", () => {
    expect(declaredTestTitles(JOIN_SOURCE)).toStrictEqual([
      "law one holds",
      "law two holds",
    ]);
  });

  test("handles test.each and ignores prose that merely says test", () => {
    expect(
      declaredTestTitles(
        [
          "// this file has a test for everything",
          'test.each([1, 2])("seed %i converges", () => {});',
          "it(",
          '  "it also counts",',
          ");",
        ].join("\n")
      )
    ).toStrictEqual(["seed %i converges", "it also counts"]);
  });
});

describe("runner readers", () => {
  test("read the FLOWS list and the BUDGET_MS ceiling", () => {
    expect(runnerFlowList(RUNNER_SOURCE)).toStrictEqual(["a.mjs", "b.mjs"]);
    expect(runnerBudgetMinutes(RUNNER_SOURCE)).toBe(10);
  });

  test("say null rather than guessing when the runner declares neither", () => {
    expect(runnerFlowList("const x = 1;")).toBeNull();
    expect(runnerBudgetMinutes("const x = 1;")).toBeNull();
  });
});

describe("validateReportRegistries", () => {
  test("accepts well-formed registries", async () => {
    expect(await run(baseMatrix())).toStrictEqual([]);
  });

  test("SABOTAGE: a join law deleted from its suite fails the count lock", async () => {
    const matrix = baseMatrix();
    matrix.joinLaws.pop();
    const errors = await run(matrix);
    expect(errors.join(" ")).toContain("but joinLaws claims 1");
  });

  test("SABOTAGE: a law naming a test its owner does not declare is caught", async () => {
    const matrix = baseMatrix();
    matrix.joinLaws[0].testName = "law nobody wrote";
    expect((await run(matrix)).join(" ")).toContain(
      "names a test its owner does not declare"
    );
  });

  test("SABOTAGE: a missing join-law owner is named, not skipped", async () => {
    const matrix = baseMatrix();
    matrix.joinLaws[0].owner = "gone.test.ts";
    expect((await run(matrix)).join(" ")).toContain(
      "join law owner does not exist: gone.test.ts"
    );
  });

  test("SABOTAGE: grid E must keep both halves", async () => {
    const scriptedOnly = baseMatrix();
    scriptedOnly.joinLaws[1].kind = "scripted";
    expect((await run(scriptedOnly)).join(" ")).toContain(
      "declares no simulation law"
    );
    const simOnly = baseMatrix();
    simOnly.joinLaws[0].kind = "simulation";
    expect((await run(simOnly)).join(" ")).toContain(
      "declares no scripted law"
    );
  });

  test("SABOTAGE: an empty registry is an error, never an empty grid", async () => {
    expect((await run(baseMatrix({ joinLaws: [] }))).join(" ")).toContain(
      "has nothing to derive"
    );
    expect(
      (await run(baseMatrix({ journeys: { suites: [] } }))).join(" ")
    ).toContain("grid G has nothing to derive");
  });

  test("SABOTAGE: unknown flow ids and seats are rejected", async () => {
    const matrix = baseMatrix();
    matrix.joinLaws[1].flow = "no-such-flow";
    matrix.joinLaws[0].seats = ["stowaway"];
    const errors = await run(matrix);
    expect(errors.join(" ")).toContain("unknown flow no-such-flow");
    expect(errors.join(" ")).toContain("unknown seat stowaway");
  });

  test("SABOTAGE: a duplicate law id is rejected", async () => {
    const matrix = baseMatrix();
    matrix.joinLaws[1].id = "law-one";
    expect((await run(matrix)).join(" ")).toContain("duplicate join law id");
  });

  test("SABOTAGE: a journey dropped from the suite fails against the runner", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites[0].flows.pop();
    const errors = await run(matrix);
    expect(errors.join(" ")).toContain("does not match its runner's");
    expect(errors.join(" ")).toContain(
      "no journeys suite declares it: flows/b.mjs"
    );
  });

  test("SABOTAGE: a journey file added to disk must be declared", async () => {
    const errors = await run(baseMatrix(), {
      flowFiles: ["flows/a.mjs", "flows/b.mjs", "flows/c.mjs"],
    });
    expect(errors.join(" ")).toContain(
      "no journeys suite declares it: flows/c.mjs"
    );
  });

  test("SABOTAGE: a budget that drifted from its runner is caught", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites[0].budgetMinutes = 45;
    expect((await run(matrix)).join(" ")).toContain(
      "declares a 45-minute budget; run.mjs enforces 10"
    );
  });

  test("SABOTAGE: a budget with no runner to enforce it is rejected", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites[0].runner = null;
    expect((await run(matrix)).join(" ")).toContain(
      "declares a budget but no runner to enforce it"
    );
  });

  test("an unbudgeted suite is an honest state, not an error", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites[0].runner = null;
    matrix.journeys.suites[0].budgetDoc = null;
    matrix.journeys.suites[0].budgetMinutes = null;
    expect(await run(matrix)).toStrictEqual([]);
  });

  test("SABOTAGE: a missing runner, budget doc or journey file is named", async () => {
    const missingRunner = baseMatrix();
    missingRunner.journeys.suites[0].runner = "gone.mjs";
    expect((await run(missingRunner)).join(" ")).toContain(
      "journey suite runner does not exist: gone.mjs"
    );
    const missingDoc = baseMatrix();
    missingDoc.journeys.suites[0].budgetDoc = "gone.md";
    expect((await run(missingDoc)).join(" ")).toContain(
      "journey budget doc does not exist: gone.md"
    );
    const missingFlow = baseMatrix();
    missingFlow.journeys.suites[0].flows[0].owner = "flows/gone.mjs";
    expect((await run(missingFlow)).join(" ")).toContain(
      "journey flow owner does not exist: flows/gone.mjs"
    );
  });

  test("SABOTAGE: a runner with no FLOWS or no BUDGET_MS is caught", async () => {
    const errors = await run(baseMatrix(), {
      sources: { ...SOURCES, "run.mjs": "// nothing here\n" },
    });
    expect(errors.join(" ")).toContain("declares no FLOWS");
    expect(errors.join(" ")).toContain("declares no BUDGET_MS");
  });

  test("SABOTAGE: a journey claiming a flow owned by another file is caught", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites[0].flows[0].flow = "sim-flow";
    expect((await run(matrix)).join(" ")).toContain(
      "claims flow sim-flow, which is owned by sim.test.ts"
    );
    const unknown = baseMatrix();
    unknown.journeys.suites[0].flows[0].flow = "no-such-flow";
    expect((await run(unknown)).join(" ")).toContain(
      "references unknown flow no-such-flow"
    );
  });

  test("SABOTAGE: the same journey declared in two suites is rejected", async () => {
    const matrix = baseMatrix();
    matrix.journeys.suites.push({
      ...matrix.journeys.suites[0],
      id: "budgeted",
    });
    const errors = await run(matrix);
    expect(errors.join(" ")).toContain("duplicate journey suite id");
    expect(errors.join(" ")).toContain("journey flow declared twice");
  });
});
