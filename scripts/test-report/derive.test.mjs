import { describe, expect, test } from "vitest";

import { loadClaims, validateClaims } from "./claims-schema.mjs";
import { flowOwnerView } from "./derive-flows.mjs";
import {
  deriveFlows,
  deriveJourneys,
  deriveStrykerConfigs,
  deriveVitestProjects,
  flowId,
  readSuiteRunners,
} from "./derive.mjs";

/**
 * #915 split the report's inputs in two: what a machine cannot derive lives in
 * `tests/claims.json`, and everything else is read off the repo at report time.
 * These cases hold that line — a derivation that silently returns nothing is
 * indistinguishable from a repo with nothing in it, and the constitution's
 * `coverage-scope-reachability` directive reads one of them.
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

describe("derivations", () => {
  test("the roster's suites reach §5 with their budgets", () => {
    const suites = readSuiteRunners();
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(suite.budgetMs).toBeGreaterThan(0);
  });

  test("a journey is listed under the suite that schedules it", () => {
    const roster = {
      suites: {
        "pr-gate": {
          budgetMs: 480_000,
          rungs: [2],
          platform: ["android"],
          flows: ["a.mjs"],
        },
      },
      flows: {
        "tests/agent-e2e-mobile/flows/a.mjs": {
          claim: "a claim",
          status: "scheduled",
        },
      },
    };
    const journeys = deriveJourneys(roster, readSuiteRunners(roster));
    expect(journeys).toHaveLength(1);
    expect(journeys[0]).toMatchObject({
      id: "pr-gate",
      rung: 2,
      platform: "android",
      budgetMs: 480_000,
    });
    expect(journeys[0].flows[0]).toMatchObject({ id: "a", claim: "a claim" });
  });

  test("flow ids drop the extension, not the name", () => {
    expect(flowId("tests/agent-e2e-mobile/flows/pairing-canary.mjs")).toBe(
      "pairing-canary"
    );
  });

  test("the flow view joins the claims file and the roster, and is never empty", async () => {
    const { claims } = loadClaims();
    const flows = deriveFlows(claims, {
      flows: {
        "tests/agent-e2e-mobile/flows/ghost.mjs": { status: "scheduled" },
      },
    });
    expect(flows.some((flow) => flow.id === "ghost")).toBe(true);
    const view = await flowOwnerView();
    expect(view.flows.length).toBeGreaterThan(100);
    for (const flow of view.flows) expect(typeof flow.owner).toBe("string");
  });

  test("the Stryker and Vitest inventories are read off disk, not typed", async () => {
    expect(deriveStrykerConfigs().length).toBeGreaterThan(0);
    for (const config of deriveStrykerConfigs()) {
      expect(config).toMatch(/^packages\/[\w-]+\/stryker\.config\.mjs$/u);
    }
    expect((await deriveVitestProjects()).length).toBeGreaterThan(0);
  });
});
