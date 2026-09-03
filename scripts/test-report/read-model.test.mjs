import { describe, expect, test } from "vitest";

import {
  buildAttention,
  buildBlockers,
  buildSinceYesterday,
} from "./model/attention.mjs";
import { buildPromises } from "./model/grids.mjs";
import {
  buildLaneBoard,
  consecutiveReds,
  passRate,
  p95,
} from "./model/lanes.mjs";
import { laneSeverity } from "./model/severity.mjs";
import { computeVerdict } from "./read-model.mjs";

function row(overrides = {}) {
  return {
    lane: "a-lane",
    rung: 4,
    platform: "any",
    status: "gating",
    severity: "S2",
    verdict: "passed",
    observedVerdict: "passed",
    durationMs: 1000,
    budgetMs: 10_000,
    p95Ms: 1000,
    overBudget: false,
    history: ["passed"],
    passRate: 100,
    demote: false,
    consecutiveReds: 0,
    lastGreen: "abc1234",
    parked: null,
    parkedSince: null,
    firstRed: null,
    firstFailingCase: null,
    cases: [],
    qualities: [],
    surfaces: [],
    previousVerdict: "passed",
    ageHours: null,
    outOfBand: false,
    ...overrides,
  };
}

describe("computeVerdict", () => {
  const today = "2026-09-02";

  test("SHIPPABLE when every unparked lane passed", () => {
    const { verdict, flip } = computeVerdict({
      rows: [row()],
      parks: [],
      today,
    });
    expect(verdict).toBe("SHIPPABLE");
    expect(flip).toBeNull();
  });

  test("HOLD on an S1 or S2 red, naming the case", () => {
    const { verdict, why } = computeVerdict({
      rows: [
        row({
          verdict: "failed",
          severity: "S1",
          firstFailingCase: "locker-gate",
        }),
      ],
      parks: [],
      today,
    });
    expect(verdict).toBe("HOLD");
    expect(why).toContain("locker-gate");
  });

  test("DEGRADED on an S3 red, never HOLD", () => {
    expect(
      computeVerdict({
        rows: [row({ verdict: "failed", severity: "S3" })],
        parks: [],
        today,
      }).verdict
    ).toBe("DEGRADED");
  });

  test("a parked lane never counts as red", () => {
    const parked = row({
      verdict: "parked",
      severity: "S1",
      parked: { until: "2026-09-16", issue: 870 },
    });
    const { verdict } = computeVerdict({
      rows: [row(), parked],
      parks: [
        { lane: parked.lane, until: "2026-09-16", issue: 870, since: today },
      ],
      today,
    });
    expect(verdict).toBe("SHIPPABLE");
  });

  test("more than three parks is itself a HOLD", () => {
    const parks = ["a", "b", "c", "d"].map((lane) => ({
      lane,
      until: "2026-09-16",
      issue: 1,
      since: today,
    }));
    const { verdict, why } = computeVerdict({ rows: [row()], parks, today });
    expect(verdict).toBe("HOLD");
    expect(why).toContain("4 lanes are parked");
  });

  test("a park older than 30 days is a HOLD", () => {
    const { verdict, why } = computeVerdict({
      rows: [row()],
      parks: [
        { lane: "old", until: "2026-10-01", issue: 1, since: "2026-07-01" },
      ],
      today,
    });
    expect(verdict).toBe("HOLD");
    expect(why).toContain("days old");
  });

  test("a night where nothing reported is a HOLD, never a silent all-clear", () => {
    const { verdict, why } = computeVerdict({
      rows: [row({ verdict: "no-evidence" })],
      parks: [],
      today,
    });
    expect(verdict).toBe("HOLD");
    expect(why).toContain("proved nothing");
  });

  test("a gating lane that wrote nothing degrades the night", () => {
    const { verdict } = computeVerdict({
      rows: [row(), row({ lane: "silent", verdict: "no-evidence" })],
      parks: [],
      today,
    });
    expect(verdict).toBe("DEGRADED");
  });
});

describe("buildLaneBoard", () => {
  const claims = { claims: [] };
  const lane = {
    id: "web-e2e",
    rung: 4,
    platform: "web",
    budgetMs: 600_000,
    qualities: ["journey"],
    surfaces: ["web-pwa"],
    status: "gating",
  };

  test("a registered lane with no evidence is no-evidence, not missing", () => {
    const { rows, counts } = buildLaneBoard({
      laneRegistry: [lane],
      evidence: new Map(),
      previousEvidence: new Map(),
      history: [],
      claims,
      today: "2026-09-02",
    });
    expect(rows[0].verdict).toBe("no-evidence");
    expect(counts["no-evidence"]).toBe(1);
  });

  test("a lane whose p95 walked past its budget degrades with the number to cut to", () => {
    const { rows } = buildLaneBoard({
      laneRegistry: [lane],
      evidence: new Map([
        ["web-e2e", { verdict: "passed", durationMs: 900_000, cases: [] }],
      ]),
      previousEvidence: new Map(),
      history: [],
      claims,
      today: "2026-09-02",
    });
    expect(rows[0].verdict).toBe("degraded");
    expect(rows[0].overBudget).toBe(true);
  });

  test("the demote flag fires below 99 % on rung 2 only", () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      label: `n${index}`,
      lanes: {
        "web-e2e": {
          verdict: index === 0 ? "failed" : "passed",
          durationMs: 1000,
        },
      },
    }));
    const evidence = new Map([
      ["web-e2e", { verdict: "passed", durationMs: 1000, cases: [] }],
    ]);
    const rung4 = buildLaneBoard({
      laneRegistry: [lane],
      evidence,
      previousEvidence: new Map(),
      history,
      claims,
      today: "2026-09-02",
    });
    const rung2 = buildLaneBoard({
      laneRegistry: [{ ...lane, rung: 2 }],
      evidence,
      previousEvidence: new Map(),
      history,
      claims,
      today: "2026-09-02",
    });
    expect(rung4.rows[0].demote).toBe(false);
    expect(rung2.rows[0].demote).toBe(true);
  });
});

describe("the numbers the promotion rules read", () => {
  test("pass rate counts only the runs that ran", () => {
    expect(passRate(["passed", "failed", "parked", "no-evidence"])).toBe(50);
    expect(passRate(["parked", "no-evidence"])).toBeNull();
  });

  test("consecutive reds counts back from tonight", () => {
    expect(consecutiveReds(["failed", "passed", "failed", "failed"])).toBe(2);
    expect(consecutiveReds(["failed", "passed"])).toBe(0);
  });

  test("p95 of nothing is null, never zero", () => {
    expect(p95([])).toBeNull();
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });
});

describe("severity", () => {
  test("a lane inherits the worst severity among the claims that name it", () => {
    const claims = [
      { id: "T1", lane: "restore-year3", severity: "S1" },
      { id: "L3", lane: "restore-year3", severity: "S4" },
    ];
    expect(
      laneSeverity({ id: "restore-year3", status: "gating" }, claims)
    ).toBe("S1");
  });

  test("an unclaimed gating lane is S2 and an unclaimed advisory lane is S4", () => {
    expect(laneSeverity({ id: "x", status: "gating" }, [])).toBe("S2");
    expect(laneSeverity({ id: "x", status: "advisory" }, [])).toBe("S4");
  });
});

describe("the three questions", () => {
  const today = "2026-09-02";

  test("§1 carries only S1 and S2, with the bisection bounds", () => {
    const blockers = buildBlockers({
      rows: [
        row({
          lane: "ios",
          verdict: "failed",
          severity: "S1",
          firstRed: "aaa",
          lastGreen: "bbb",
        }),
        row({ lane: "scale", verdict: "failed", severity: "S3" }),
      ],
      today,
    });
    expect(blockers.map((entry) => entry.lane)).toEqual(["ios"]);
    expect(blockers[0].firstRed).toBe("aaa");
    expect(blockers[0].lastGreen).toBe("bbb");
  });

  test("§3 lists every lane needing a human, each with a concrete deadline", () => {
    const queue = buildAttention({
      rows: [
        row(),
        row({ lane: "ios", verdict: "failed", severity: "S1", ageHours: 6 }),
        row({
          lane: "android",
          verdict: "parked",
          parked: { until: "2026-09-16", issue: 870 },
          parkedSince: "2026-08-24",
        }),
      ],
      today,
    });
    expect(queue.map((entry) => entry.lane)).toEqual(["android", "ios"]);
    expect(queue[0].deadline).toBe("expires 2026-09-16");
    expect(queue[1].deadline).toContain("owned by");
  });

  test("§2 is computed candidate-to-candidate", () => {
    const since = buildSinceYesterday({
      rows: [
        row({ lane: "new-red", verdict: "failed" }),
        row({ lane: "new-green", verdict: "passed" }),
        row({
          lane: "expiring",
          verdict: "parked",
          parked: { until: "2026-09-05", issue: 901 },
        }),
      ],
      previousEvidence: new Map([
        ["new-red", { verdict: "passed" }],
        ["new-green", { verdict: "failed" }],
      ]),
      today,
    });
    expect(since.newRed.map((entry) => entry.lane)).toEqual(["new-red"]);
    expect(since.newGreen.map((entry) => entry.lane)).toEqual(["new-green"]);
    expect(since.expiring[0].why).toContain("3d");
  });
});

describe("§7 promises × surfaces", () => {
  const claims = {
    vocabulary: {
      qualities: [{ id: "journey", label: "Journey" }],
      surfaces: [
        { id: "mobile-native", label: "Mobile native", absorbs: ["mobile"] },
        { id: "backup", label: "Backup", absorbs: ["backup-restore"] },
      ],
    },
    naCells: {
      "surface.backup-restore.journey": {
        kind: "impossibility",
        reviewed: "2026-09-02",
        restated:
          "Backup has no user journey of its own; the restore drill owns the claim.",
      },
    },
  };
  const registry = [
    {
      id: "mobile-e2e-ios",
      qualities: ["journey"],
      surfaces: ["mobile-native"],
    },
  ];

  test("a lane that claims a cell and writes nothing renders no evidence there", () => {
    const { cells } = buildPromises({
      claims,
      evidence: new Map(),
      laneRegistry: registry,
    });
    expect(cells[0][0]).toMatchObject({
      state: "no-evidence",
      lanes: ["mobile-e2e-ios"],
    });
  });

  test("a failing lane reds the cell and names the lane behind it", () => {
    const evidence = new Map([["mobile-e2e-ios", { verdict: "failed" }]]);
    const { cells, counts } = buildPromises({
      claims,
      evidence,
      laneRegistry: registry,
    });
    expect(cells[0][0].state).toBe("failed");
    expect(counts.failed).toBe(1);
  });

  test("a cell with no lane is n/a only when the claims file says why", () => {
    const { cells } = buildPromises({
      claims,
      evidence: new Map(),
      laneRegistry: registry,
    });
    expect(cells[0][1].state).toBe("n/a");
    expect(cells[0][1].reason).toContain("no user journey");
  });
});
