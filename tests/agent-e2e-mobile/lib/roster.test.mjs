// Spec for the roster reader (#915 Wave 2).
//
// This module is the load-bearing seam of the collapse: seven runner files
// carried their `FLOWS` and `BUDGET_MS` as literals, and three separate gates
// read those literals back off disk. All of that is now one JSON document with
// one reader, so a defect here does not produce a wrong number — it produces a
// lane that schedules a different set of journeys than the report says it ran.
//
// Two halves. The FIXTURE half drives `validateRoster` over hand-built trees,
// including the shapes the runner files used to make unexpressible. The SHIPPED
// half asserts invariants against the real `roster.json`, because a validator
// that is perfect over fixtures and silent about the tree it ships with is the
// exact gate shape this repo keeps finding.

import { describe, expect, it } from "vitest";

import {
  flowsFor,
  lanesFor,
  loadRoster,
  plan,
  RUNGS,
  suiteBudgetMs,
  suitesFor,
  validateRoster,
} from "./roster.mjs";

const FLOWS_DIR = "tests/agent-e2e-mobile/flows";

/** A minimal well-formed roster; each case below breaks exactly one thing. */
function fixture(overrides = {}) {
  return {
    suites: {
      gate: {
        budgetMs: 480_000,
        doc: "flows/gate-budget.md",
        rungs: [2],
        platform: ["android"],
        lane: "pr-gate",
        canaryCount: 1,
        reuseAfter: 1,
        flows: ["a.mjs"],
        onBudgetBreach: "",
      },
    },
    lanes: {
      "pr-gate": {
        workflow: ".github/workflows/ci.yml",
        job: "mobile-device-gate",
        rung: 2,
        blocking: true,
        platform: "android",
        why: "",
      },
    },
    flows: {
      [`${FLOWS_DIR}/a.mjs`]: {
        status: "scheduled",
        suite: ["gate"],
        rungs: [2],
        platform: ["android"],
        budgetMs: 120_000,
        claim: "a claim long enough to be judged by a reader",
      },
    },
    ...overrides,
  };
}

describe("validateRoster", () => {
  it("passes a well-formed roster", () => {
    expect(validateRoster(fixture())).toEqual([]);
  });

  it("refuses a suite that prices nothing", () => {
    const roster = fixture();
    delete roster.suites.gate.budgetMs;
    expect(validateRoster(roster).join("\n")).toMatch(/no positive budgetMs/u);
  });

  it("refuses a member with no roster row — the mistake a FLOWS literal could not make", () => {
    const roster = fixture();
    roster.suites.gate.flows.push("ghost.mjs");
    expect(validateRoster(roster).join("\n")).toMatch(/no .*flows\[\] row/u);
  });

  it("refuses a member that cannot fit its own suite's deadline", () => {
    const roster = fixture();
    roster.flows[`${FLOWS_DIR}/a.mjs`].budgetMs = 999_000_000;
    expect(validateRoster(roster).join("\n")).toMatch(
      /whole aggregate ceiling/u
    );
  });

  it("refuses a flow whose stored rungs disagree with its suite membership", () => {
    // The derived fields are STORED, because the report and the linters read a
    // flow row directly. Stored means they can drift, which is why they are
    // checked rather than trusted.
    const roster = fixture();
    roster.flows[`${FLOWS_DIR}/a.mjs`].rungs = [4];
    expect(validateRoster(roster).join("\n")).toMatch(/derives \[2\]/u);
  });

  it("refuses a scheduled flow that belongs to no suite", () => {
    const roster = fixture();
    roster.suites.gate.flows = ["b.mjs"];
    roster.flows[`${FLOWS_DIR}/b.mjs`] = {
      status: "scheduled",
      suite: ["gate"],
      rungs: [2],
      platform: ["android"],
      budgetMs: 1000,
      claim: "another claim long enough to be judged",
    };
    expect(validateRoster(roster).join("\n")).toMatch(/belongs to no suite/u);
  });

  it("refuses a blocking lane above rung 2, and a non-blocking one on it", () => {
    const above = fixture();
    above.lanes["pr-gate"].rung = 4;
    expect(validateRoster(above).join("\n")).toMatch(/Only rung 2 blocks/u);
    const soft = fixture();
    soft.lanes["pr-gate"].blocking = false;
    expect(validateRoster(soft).join("\n")).toMatch(/is the rung that blocks/u);
  });

  it("refuses a rung the ladder does not have", () => {
    const roster = fixture();
    roster.suites.gate.rungs = [7];
    expect(validateRoster(roster).join("\n")).toMatch(/device rungs are/u);
  });
});

describe("selection", () => {
  it("keeps roster order, which is a lane's execution order", () => {
    const roster = fixture();
    roster.suites.later = { ...roster.suites.gate, rungs: [2] };
    expect(suitesFor({ rung: 2, platform: "android", roster })).toEqual([
      "gate",
      "later",
    ]);
  });

  it("filters by platform as well as rung", () => {
    const roster = fixture();
    expect(suitesFor({ rung: 2, platform: "ios", roster })).toEqual([]);
  });

  it("narrows to one suite when asked, and to none when it is on another rung", () => {
    const roster = fixture();
    expect(
      suitesFor({ rung: 2, platform: "android", suite: "gate", roster })
    ).toEqual(["gate"]);
    expect(
      suitesFor({ rung: 4, platform: "android", suite: "gate", roster })
    ).toEqual([]);
  });

  it("plan() carries the members in suite order with their rows attached", () => {
    const [entry] = plan({ rung: 2, platform: "android", roster: fixture() });
    expect(entry.flows.map((flow) => flow.path)).toEqual([
      `${FLOWS_DIR}/a.mjs`,
    ]);
    expect(entry.flows[0].claim).toMatch(/long enough/u);
    expect(entry.budgetMs).toBe(480_000);
  });

  it("flowsFor() dedupes a flow that sits in two suites and names both", () => {
    const roster = fixture();
    roster.suites.second = { ...roster.suites.gate, rungs: [2] };
    const [flow] = flowsFor({ rung: 2, platform: "android", roster });
    expect(flow.suites).toEqual(["gate", "second"]);
  });

  it("lanesFor() selects by rung", () => {
    const roster = fixture();
    expect(Object.keys(lanesFor({ rung: 2, roster }))).toEqual(["pr-gate"]);
    expect(Object.keys(lanesFor({ rung: 4, roster }))).toEqual([]);
  });
});

describe("the shipped roster", () => {
  const roster = loadRoster();

  it("agrees with itself", () => {
    expect(validateRoster(roster)).toEqual([]);
  });

  it("spends ZERO iOS minutes on rung 2", () => {
    // A #915 non-goal in as many words: "No iOS on PRs". Rung 2 is the only
    // rung that blocks a merge, so this is the one selection whose emptiness is
    // a product decision rather than an accident of the table.
    expect(suitesFor({ rung: 2, platform: "ios", roster })).toEqual([]);
    expect(suitesFor({ rung: 2, platform: "android", roster }).length).toBe(1);
  });

  it("carries an iOS verdict on every candidate", () => {
    // The Wave 2 exit criterion. Rung 3 is every push to main.
    expect(suitesFor({ rung: 3, platform: "ios", roster })).toContain(
      "ios-smoke"
    );
    expect(suiteBudgetMs("ios-smoke", roster)).toBeLessThanOrEqual(10 * 60_000);
  });

  it("keeps the PR gate inside eight warm minutes", () => {
    expect(suiteBudgetMs("pr-gate", roster)).toBe(8 * 60_000);
  });

  it("never lets a promoting flow reach rung 2", () => {
    // D3, mechanically. `scripts/lint-e2e-wiring.mjs` checks the same rule
    // against lane BLOCKING; this checks it against the rung, so a lane that
    // forgot its `blocking` flag cannot let one through.
    const staging = Object.entries(roster.flows).filter(
      ([, row]) => row.status === "promoting"
    );
    expect(staging.length).toBeGreaterThan(0);
    for (const [, row] of staging) expect(row.rungs).not.toContain(2);
  });

  it("puts every scheduled flow on at least one rung the ladder has", () => {
    for (const [rel, row] of Object.entries(roster.flows)) {
      if (row.status === "exploratory") continue;
      expect(row.rungs.length, rel).toBeGreaterThan(0);
      for (const rung of row.rungs) expect(RUNGS, rel).toContain(rung);
    }
  });

  it("prices every suite doc it names", () => {
    for (const spec of Object.values(roster.suites))
      expect(spec.doc).toMatch(/^tests\/agent-e2e-mobile\/flows\/.+\.md$/u);
  });
});
