import { describe, expect, test } from "vitest";

import {
  declaredTestTitles,
  runnerBudgetMinutes,
  runnerFlowList,
  validateReportRegistries,
} from "./validate-report-registries.mjs";

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

const SUITES = [
  {
    id: "budgeted",
    runner: "budget.md",
    budgetMs: 720_000,
    flows: ["a.mjs", "b.mjs"],
  },
];
const ROSTER = {
  suites: {},
  flows: {
    "tests/agent-e2e-mobile/flows/a.mjs": { status: "scheduled" },
    "tests/agent-e2e-mobile/flows/b.mjs": { status: "scheduled" },
  },
};

function run(
  matrix,
  { sources = SOURCES, flowFiles, suites = SUITES, roster = ROSTER } = {}
) {
  return validateReportRegistries(matrix, {
    readSource: async (file) => sources[file] ?? null,
    flowFiles: flowFiles ?? [
      "tests/agent-e2e-mobile/flows/a.mjs",
      "tests/agent-e2e-mobile/flows/b.mjs",
    ],
    suites,
    roster,
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
    expect((await run(baseMatrix(), { suites: [] })).join(" ")).toContain(
      "the roster declares no suites"
    );
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

  test("SABOTAGE: a committed journey no suite schedules is caught", async () => {
    const errors = await run(baseMatrix(), {
      suites: [{ ...SUITES[0], flows: ["a.mjs"] }],
    });
    expect(errors.join(" ")).toContain("no roster suite schedules it");
    expect(errors.join(" ")).toContain("b.mjs");
  });

  test("SABOTAGE: a suite scheduling a flow that is gone is caught", async () => {
    const errors = await run(baseMatrix(), {
      suites: [{ ...SUITES[0], flows: ["a.mjs", "b.mjs", "ghost.mjs"] }],
    });
    expect(errors.join(" ")).toContain("does not exist on disk");
  });

  test("a flow the roster declares promoting needs no suite", async () => {
    const errors = await run(baseMatrix(), {
      suites: [{ ...SUITES[0], flows: ["a.mjs"] }],
      roster: {
        suites: {},
        flows: {
          "tests/agent-e2e-mobile/flows/a.mjs": { status: "scheduled" },
          "tests/agent-e2e-mobile/flows/b.mjs": { status: "promoting" },
        },
      },
    });
    expect(errors).toStrictEqual([]);
  });

  test("SABOTAGE: a suite with no budget is rejected", async () => {
    const errors = await run(baseMatrix(), {
      suites: [{ ...SUITES[0], budgetMs: null }],
    });
    expect(errors.join(" ")).toContain("declares no budgetMs");
  });

  test("SABOTAGE: a duplicate suite id is rejected", async () => {
    const errors = await run(baseMatrix(), { suites: [SUITES[0], SUITES[0]] });
    expect(errors.join(" ")).toContain("duplicate suite id");
  });
});
