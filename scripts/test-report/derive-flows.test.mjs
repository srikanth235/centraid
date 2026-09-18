import { describe, expect, test } from "vitest";

import { loadClaims, validateClaims } from "./claims-schema.mjs";
import { deriveFlows, flowOwnerView } from "./derive-flows.mjs";

/**
 * The claims file and the flow view derived from it. A derivation that
 * silently returns nothing is indistinguishable from a repo with nothing in
 * it, and the constitution's `coverage-scope-reachability` directive reads
 * this one.
 */

describe("the claims file", () => {
  test("the committed file validates", () => {
    const { claims, errors } = loadClaims();
    expect(errors).toEqual([]);
    expect(claims.claims.length).toBeGreaterThan(0);
    expect(claims.lanes.length).toBeGreaterThan(0);
  });

  test("declares the 11 × 10 vocabulary the promises grid joins on", () => {
    const { claims } = loadClaims();
    expect(claims.vocabulary.qualities).toHaveLength(11);
    expect(claims.vocabulary.surfaces).toHaveLength(10);
  });

  test("SABOTAGE: a lane tagged with a quality nobody declared is rejected", () => {
    const { claims } = loadClaims();
    const broken = {
      ...claims,
      lanes: [{ ...claims.lanes[0], qualities: ["telepathy"] }],
    };
    expect(validateClaims(broken).errors.join(" ")).toContain(
      "not in the vocabulary"
    );
  });

  test("SABOTAGE: a claim with no demonstrated-red date is rejected", () => {
    const { claims } = loadClaims();
    const broken = {
      ...claims,
      claims: [{ ...claims.claims[0], demonstratedRed: { date: null } }],
    };
    expect(validateClaims(broken).errors.join(" ")).toContain(
      "demonstratedRed.date"
    );
  });

  test("SABOTAGE: an n/a cell with a fragment for a reason is rejected", () => {
    const { claims } = loadClaims();
    const broken = {
      ...claims,
      naCells: {
        "x.y.z": {
          kind: "impossibility",
          reviewed: "2026-09-02",
          restated: "no.",
        },
      },
    };
    expect(validateClaims(broken).errors.join(" ")).toContain("at length");
  });
});

describe("the flow view", () => {
  test("rows are the claims file's flows, sorted by id", () => {
    const flows = deriveFlows({
      flows: [
        { id: "b-flow", owner: "packages/b/src/b.test.ts" },
        { id: "a-flow", owner: "packages/a/src/a.test.ts", tier: "unit" },
      ],
    });
    expect(flows.map((flow) => flow.id)).toEqual(["a-flow", "b-flow"]);
    expect(flows[0]).toMatchObject({ tier: "unit", minimumTests: null });
  });

  test("the committed view is never empty and every row names an owner", () => {
    const view = flowOwnerView();
    expect(view.flows.length).toBeGreaterThan(0);
    for (const flow of view.flows) expect(typeof flow.owner).toBe("string");
  });
});
