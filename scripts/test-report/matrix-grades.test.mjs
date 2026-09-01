import { describe, expect, test } from "vitest";

import {
  GRADE_ORDER,
  MAX_EVIDENCE_AGE_HOURS,
  computeCellGrade,
  countDeclaredTests,
  gradeMatrix,
  gradeRank,
  matchCoverageScope,
  matchMutationScope,
} from "./matrix-grades.mjs";

/** A cell whose evidence is, on every axis, good enough for solid. */
const solidCell = (overrides = {}) => ({
  cellId: "vault-core.contracts",
  owner: "packages/vault/src/gateway/gateway.contract.test.ts",
  tier: "contract",
  ownerExists: true,
  declaredTests: 38,
  skipSites: [],
  envGate: null,
  flows: [
    {
      id: "vault-consent-write",
      owner: "packages/vault/src/gateway/gateway.contract.test.ts",
      minimumTests: 38,
      declaredTests: 38,
    },
  ],
  coverageScope: "packages/vault/src/**",
  coverageFloor: { lines: 87 },
  mutationScope: "packages/vault",
  mutationFloor: 97,
  absoluteWeaknessBelow: 60,
  budgetRegistered: false,
  run: { state: "unknown" },
  ...overrides,
});

describe("countDeclaredTests", () => {
  test("counts vitest and playwright declarations, including modifiers", () => {
    expect(
      countDeclaredTests(
        "test('a', () => {});\nit.each([1])('b', () => {});\ntest.skipIf(x)('c', () => {});",
        "a.test.ts"
      )
    ).toBe(3);
  });

  test("counts agent-e2e flows in their own grammar instead of reporting zero", () => {
    const flow = [
      "await runFlow('x', async (ctx) => {",
      "  if (!ok) throw new Error('bad');",
      "  await ctx.expectTunnelRefused(device);",
      "});",
    ].join("\n");
    expect(
      countDeclaredTests(flow, "tests/agent-e2e-pairing/flows/x.mjs")
    ).toBe(2);
    expect(countDeclaredTests(flow, "packages/x/src/x.test.ts")).toBe(0);
  });

  test("counts an assertion the harness emits, and not its import", () => {
    const flow = [
      'import { AWAIT_LAUNCHER, runFlow } from "../lib/harness.mjs";',
      "await runFlow('x', async (ctx) => {",
      `  await ctx.run(yaml + \${AWAIT_LAUNCHER}, 'a');`,
      "});",
    ].join("\n");
    expect(countDeclaredTests(flow, "tests/agent-e2e-mobile/flows/x.mjs")).toBe(
      1
    );
  });

  test("an import alone declares nothing", () => {
    expect(
      countDeclaredTests(
        'import { AWAIT_LAUNCHER } from "../lib/harness.mjs";',
        "tests/agent-e2e-mobile/flows/x.mjs"
      )
    ).toBe(0);
  });
});

describe("evidence scope matching", () => {
  test("a workspace with no coverage floor resolves to no scope", () => {
    const floors = { lines: 62, "packages/vault/src/**": { lines: 87 } };
    const workspaces = ["packages/vault", "apps/mobile"];
    expect(
      matchCoverageScope("packages/vault/src/a.test.ts", floors, workspaces)
    ).toBe("packages/vault/src/**");
    expect(
      matchCoverageScope("apps/mobile/src/a.test.ts", floors, workspaces)
    ).toBeNull();
  });

  test("mutation seeds match by longest package prefix", () => {
    const floors = {
      _absoluteWeaknessBelow: 60,
      "packages/client": 50,
      "packages/client/src/replica": 70,
    };
    expect(
      matchMutationScope("packages/client/src/replica/a.test.ts", floors)
    ).toBe("packages/client/src/replica");
    expect(matchMutationScope("apps/web/src/a.test.ts", floors)).toBeNull();
  });
});

describe("computeCellGrade", () => {
  test("grades solid only when every axis of evidence holds", () => {
    const { grade, reasons } = computeCellGrade(solidCell());
    expect(reasons).toEqual([]);
    expect(grade).toBe("solid");
    expect(gradeRank(grade)).toBe(GRADE_ORDER.length - 1);
  });

  test("solid is uncomputable for an owner that can skip itself", () => {
    const { grade, reasons } = computeCellGrade(
      solidCell({ skipSites: [{ key: "a#1", kind: "static-skip" }] })
    );
    expect(grade).toBe("partial");
    expect(reasons.join("\n")).toContain("can skip itself");
  });

  test("solid is uncomputable for an env-gated owner", () => {
    const { grade } = computeCellGrade(
      solidCell({ envGate: { env: "CENTRAID_RUN_NATIVE_TUNNEL", kind: "x" } })
    );
    expect(grade).toBe("partial");
  });

  test("solid is uncomputable without a flow that declares minimumTests", () => {
    expect(computeCellGrade(solidCell({ flows: [] })).grade).toBe("partial");
    const unfloored = computeCellGrade(
      solidCell({
        flows: [{ id: "f", owner: solidCell().owner, minimumTests: null }],
      })
    );
    expect(unfloored.grade).toBe("partial");
    expect(unfloored.reasons.join("\n")).toContain("no flow on this cell");
  });

  test("solid is uncomputable for a package below the mutation weakness floor", () => {
    const { grade, reasons } = computeCellGrade(
      solidCell({ mutationScope: "packages/backup", mutationFloor: 42 })
    );
    expect(grade).toBe("partial");
    expect(reasons.join("\n")).toContain("_absoluteWeaknessBelow");
  });

  test("solid is uncomputable where no coverage floor gates the workspace", () => {
    const { grade } = computeCellGrade(
      solidCell({ coverageScope: null, coverageFloor: null })
    );
    expect(grade).toBe("partial");
  });

  test("a rig with no registered budget cannot be solid", () => {
    const rig = solidCell({
      tier: "perf",
      coverageScope: null,
      mutationScope: null,
      budgetRegistered: false,
    });
    expect(computeCellGrade(rig).grade).toBe("partial");
    expect(computeCellGrade({ ...rig, budgetRegistered: true }).grade).toBe(
      "solid"
    );
  });

  test("an oversubscribed owner cannot back a solid cell", () => {
    const { grade, reasons } = computeCellGrade(
      solidCell({
        fileLoads: [{ file: "a.spec.ts", claimed: 2, declared: 1 }],
      })
    );
    expect(grade).toBe("partial");
    expect(reasons.join("\n")).toContain("oversubscribed");
  });

  test("a cell owner that owns none of the cell's flows cannot be solid", () => {
    const { grade, reasons } = computeCellGrade(
      solidCell({ owner: "packages/vault/src/other.test.ts", declaredTests: 4 })
    );
    expect(grade).toBe("partial");
    expect(reasons.join("\n")).toContain("owns none of this cell's flows");
  });

  test("a missing or empty owner is a gap, not a partial", () => {
    expect(computeCellGrade(solidCell({ owner: null })).grade).toBe("gap");
    expect(computeCellGrade(solidCell({ ownerExists: false })).grade).toBe(
      "gap"
    );
    expect(computeCellGrade(solidCell({ declaredTests: 0 })).grade).toBe("gap");
  });

  test("a shrunken flow contract is a gap", () => {
    const { grade } = computeCellGrade(
      solidCell({
        flows: [
          {
            id: "f",
            owner: solidCell().owner,
            minimumTests: 38,
            declaredTests: 2,
          },
        ],
      })
    );
    expect(grade).toBe("gap");
  });

  test("absent run evidence is unknown, never health", () => {
    const unknown = computeCellGrade(solidCell({ run: { state: "unknown" } }));
    expect(unknown.grade).toBe("solid");
    expect(unknown.evidence.run.state).toBe("unknown");
    expect(computeCellGrade(solidCell({ run: { state: "zero" } })).grade).toBe(
      "gap"
    );
    expect(
      computeCellGrade(solidCell({ run: { state: "failed" } })).grade
    ).toBe("gap");
    expect(MAX_EVIDENCE_AGE_HOURS).toBe(36);
  });
});

describe("gradeMatrix", () => {
  const matrix = {
    dimensions: [{ id: "contracts", label: "Contracts", lane: "per-pr" }],
    surfaces: [
      { id: "vault", label: "Vault", assessment: { contracts: "solid" } },
    ],
    workspaceSurfaces: { "packages/vault": "vault" },
    cellOwners: {
      "vault.contracts": {
        owner: "packages/vault/src/a.test.ts",
        tier: "unit",
      },
    },
    flows: [
      {
        id: "vault-law",
        name: "Vault law",
        surface: "vault",
        dimension: "contracts",
        tier: "unit",
        owner: "packages/vault/src/a.test.ts",
        minimumTests: 2,
      },
    ],
    notes: {},
  };
  const options = {
    coverageFloors: { "packages/vault/src/**": { lines: 87 } },
    mutationFloors: { _absoluteWeaknessBelow: 60, "packages/vault": 97 },
    rigBudgets: { rigs: {} },
    runEvidence: { state: "absent", owners: new Map() },
    sources: new Map([
      [
        "packages/vault/src/a.test.ts",
        "test('a', () => {});\ntest('b', () => {});",
      ],
    ]),
  };

  test("a declaration the evidence supports passes", async () => {
    const { errors, cells } = await gradeMatrix(matrix, options);
    expect(errors).toEqual([]);
    expect(cells[0].computed).toBe("solid");
  });

  test("a declaration above the computed ceiling is an error", async () => {
    const weakened = structuredClone(matrix);
    weakened.flows[0].minimumTests = null;
    const { errors } = await gradeMatrix(weakened, options);
    expect(errors.join("\n")).toContain("declares solid but the evidence only");
  });

  test("an under-claim with a note is accepted silently", async () => {
    const under = structuredClone(matrix);
    under.surfaces[0].assessment.contracts = "partial";
    const bare = await gradeMatrix(under, options);
    expect(bare.warnings.join("\n")).toContain("promote it");
    under.notes["vault.contracts"] = "Android journey is still unproven.";
    const explained = await gradeMatrix(under, options);
    expect(explained.warnings).toEqual([]);
  });
});
