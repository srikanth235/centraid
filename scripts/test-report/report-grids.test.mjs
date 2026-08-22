import { describe, expect, test } from "vitest";

import {
  buildAdversaryPanel,
  buildConsentLedger,
  buildJoinGrid,
  buildJourneyGrid,
} from "./report-grids.mjs";

/**
 * #839 Wave 5 — grids E, F, G and the consent ledger.
 *
 * The rule under test in every case is the same one: **a lane that dies
 * renders grey, it never vanishes.** So each grid is built twice — once with
 * evidence, once with the evidence removed — and the row count must not move.
 * A grid that shrinks when a lane goes silent is a grid that reports good news
 * by subtraction, which is gap G15.
 */

/** An evidence lookup over `{owner: status}`. */
function lookupOver(results) {
  return (owner) =>
    owner in results
      ? {
          status: results[owner],
          duration: 1_000,
          lastAt: "2026-08-20T00:00:00Z",
        }
      : undefined;
}

const JOIN_MATRIX = {
  seats: [{ id: "origin", label: "Origin" }],
  joinLaws: [
    {
      id: "scripted-one",
      label: "Scripted one",
      kind: "scripted",
      lane: "protocol-join",
      owner: "join.test.ts",
      testName: "t",
      flow: null,
      seats: ["origin"],
      statement: "s",
    },
    {
      id: "sim-one",
      label: "Sim one",
      kind: "simulation",
      lane: "per-pr",
      owner: "sim.test.ts",
      testName: "t",
      flow: "sim-flow",
      seats: ["origin"],
      statement: "s",
    },
  ],
};

const JOURNEY_MATRIX = {
  flows: [],
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
      {
        id: "standalone",
        label: "Standalone",
        runner: null,
        budgetDoc: null,
        budgetMinutes: null,
        flows: [{ id: "c", label: "C", owner: "flows/c.mjs", flow: null }],
      },
    ],
  },
};

describe("grid E — join laws and simulation", () => {
  test("rows come from the registry, split into scripted and simulation", () => {
    const grid = buildJoinGrid(
      JOIN_MATRIX,
      lookupOver({ "join.test.ts": "passed", "sim.test.ts": "passed" })
    );
    expect(grid.rows.map((row) => row.id)).toStrictEqual([
      "scripted-one",
      "sim-one",
    ]);
    expect(grid.counts).toMatchObject({
      scripted: 1,
      simulation: 1,
      passed: 2,
      failed: 0,
    });
  });

  test("ZERO-GREY: a dead lane keeps its row and renders missing", () => {
    const alive = buildJoinGrid(
      JOIN_MATRIX,
      lookupOver({ "join.test.ts": "passed", "sim.test.ts": "passed" })
    );
    const dead = buildJoinGrid(JOIN_MATRIX, lookupOver({}));
    expect(dead.rows).toHaveLength(alive.rows.length);
    expect(dead.rows.map((row) => row.state)).toStrictEqual([
      "missing",
      "missing",
    ]);
    expect(dead.counts.passed).toBe(0);
  });

  test("a failing join law is reported as failed, not as absence", () => {
    const grid = buildJoinGrid(
      JOIN_MATRIX,
      lookupOver({ "join.test.ts": "failed", "sim.test.ts": "passed" })
    );
    expect(grid.counts).toMatchObject({ failed: 1, passed: 1 });
  });
});

describe("grid G — journeys with budget vs actual", () => {
  test("suites carry their runner's budget; an unbudgeted suite says null", () => {
    const grid = buildJourneyGrid(JOURNEY_MATRIX, lookupOver({}));
    expect(grid.suites.map((suite) => suite.budgetMinutes)).toStrictEqual([
      10,
      null,
    ]);
    expect(grid.suites[0].budgetMs).toBe(600_000);
    expect(grid.counts).toMatchObject({ journeys: 3, unbudgeted: 1 });
  });

  test("an aggregate actual needs EVERY journey in the suite to have reported", () => {
    const partial = buildJourneyGrid(
      JOURNEY_MATRIX,
      lookupOver({ "flows/a.mjs": "passed" })
    );
    expect(partial.suites[0].actualMs).toBeNull();
    const complete = buildJourneyGrid(
      JOURNEY_MATRIX,
      lookupOver({ "flows/a.mjs": "passed", "flows/b.mjs": "passed" })
    );
    expect(complete.suites[0].actualMs).toBe(2_000);
  });

  test("ZERO-GREY: with no run evidence every journey row survives as missing", () => {
    const grid = buildJourneyGrid(JOURNEY_MATRIX, lookupOver({}));
    expect(grid.counts).toMatchObject({ journeys: 3, missing: 3, passed: 0 });
  });
});

describe("grid F — the adversary panel", () => {
  const input = {
    mutationSeeds: [
      { id: "packages/vault", label: "vault" },
      { id: "packages/cli", label: "cli" },
    ],
    mutationFloors: { "packages/vault": 97, "packages/cli": 90 },
    mutationRows: [{ scope: "packages/vault", score: 99 }],
    fuzzTargets: [
      { id: "wal-keys", title: "WAL addresses", entry: "wal-format.ts" },
      { id: "fts-match", title: "FTS match", entry: "search.ts" },
    ],
    fuzzCorpus: {
      "wal-keys": { seeds: 6, crashers: 1 },
      "fts-match": { seeds: 10, crashers: 0 },
    },
    knownFindings: {
      classes: {
        "wal.closer-roundtrip-rejected": {
          issue: 839,
          status: "open",
          found: "scripts/fuzz/crashers/wal-keys/x.json",
        },
      },
    },
    engineRegistry: [
      { id: "custody", label: "Custody", propertyFlow: "custody-props" },
      { id: "placement", label: "Placement", propertyFlow: null },
    ],
    flows: [{ id: "custody-props", owner: "custody-properties.test.ts" }],
    lookup: lookupOver({ "custody-properties.test.ts": "passed" }),
    historySeries: () => [],
  };

  test("mutation rows read their floor and score, and grade against the floor", () => {
    const panel = buildAdversaryPanel(input);
    expect(panel.mutation).toMatchObject([
      { id: "packages/vault", score: 99, floor: 97, state: "passed" },
      { id: "packages/cli", score: null, floor: 90, state: "missing" },
    ]);
    expect(panel.counts.mutationSeeds).toBe(2);
  });

  test("a seed under its floor is failed", () => {
    const panel = buildAdversaryPanel({
      ...input,
      mutationRows: [{ scope: "packages/vault", score: 50 }],
    });
    expect(panel.mutation[0].state).toBe("failed");
    expect(panel.counts.mutationBelowFloor).toBe(1);
  });

  test("a fuzz finding attaches to the target its crasher path names, not its class prefix", () => {
    const panel = buildAdversaryPanel(input);
    expect(panel.fuzz[0]).toMatchObject({
      id: "wal-keys",
      seeds: 6,
      crashers: 1,
      state: "pinned",
    });
    expect(panel.fuzz[0].findings).toHaveLength(1);
    expect(panel.fuzz[1].state).toBe("passed");
    expect(panel.counts.pinnedFindings).toBe(1);
  });

  test("an engine with no property flow keeps its row and reads unowned", () => {
    const panel = buildAdversaryPanel(input);
    expect(panel.properties).toHaveLength(2);
    expect(panel.properties[1]).toMatchObject({
      id: "placement",
      flow: null,
      state: "unowned",
    });
    expect(panel.counts.enginesWithoutProperty).toBe(1);
  });

  test("NEVER FAKE HISTORY: a sparkline needs two real points or it stays null", () => {
    expect(buildAdversaryPanel(input).mutation[0].sparkline).toBeNull();
    expect(
      buildAdversaryPanel({ ...input, historySeries: () => [97] }).mutation[0]
        .sparkline
    ).toBeNull();
    expect(
      buildAdversaryPanel({
        ...input,
        historySeries: () => [97, null, 99],
      }).mutation[0].sparkline
    ).toStrictEqual([97, 99]);
  });

  test("ZERO-GREY: with nothing measured every row survives", () => {
    const panel = buildAdversaryPanel({
      ...input,
      mutationRows: [],
      knownFindings: null,
      lookup: lookupOver({}),
    });
    expect(panel.mutation).toHaveLength(2);
    expect(panel.fuzz).toHaveLength(2);
    expect(panel.properties).toHaveLength(2);
    expect(panel.properties[0].state).toBe("missing");
  });
});

describe("the consent ledger", () => {
  const matrix = {
    seats: [
      { id: "origin", label: "Origin" },
      { id: "custodian", label: "Custodian" },
    ],
    consentLedger: [
      {
        id: "gateway",
        label: "Gateway",
        enforcement: ["consent.ts"],
        refusalGrammar: "consent.ts#Deny",
        adversary: { owner: "gateway.contract.test.ts", flow: null },
        seats: ["origin", "custodian"],
        note: "n",
      },
      {
        id: "egress",
        label: "Egress",
        enforcement: ["dispatch.ts"],
        refusalGrammar: "dispatch.ts#Deny",
        adversary: { owner: null, flow: null },
        seats: ["origin"],
        note: "n",
      },
    ],
  };

  test("one row per layer, with seat coverage against the seat registry", () => {
    const ledger = buildConsentLedger(
      matrix,
      lookupOver({ "gateway.contract.test.ts": "passed" })
    );
    expect(ledger.rows).toHaveLength(2);
    expect(
      ledger.rows[0].seatCoverage.map((seat) => seat.covered)
    ).toStrictEqual([true, true]);
    expect(
      ledger.rows[1].seatCoverage.map((seat) => seat.covered)
    ).toStrictEqual([true, false]);
    expect(ledger.counts).toMatchObject({
      layers: 2,
      withoutAdversary: 1,
      fullSeatCoverage: 1,
    });
  });

  test("a layer with no adversary reads unowned rather than passing quietly", () => {
    const ledger = buildConsentLedger(matrix, lookupOver({}));
    expect(ledger.rows[1].state).toBe("unowned");
    expect(ledger.rows[0].state).toBe("missing");
  });
});
