import { describe, expect, test } from "vitest";

import {
  attentionQueueForIssue,
  buildAttentionQueue,
  computeVerdict,
  issueNumbersInNote,
  severityFor,
  verdictDelta,
} from "./report-verdict.mjs";

/**
 * #839 Wave 5 — the verdict strip and attention queue.
 *
 * Every case here is a SABOTAGE of one input against the same well-formed
 * baseline: red one cell and the verdict must flip, silence one lane and the
 * queue must pick it up. A verdict that survives its own evidence going red is
 * a hand-assigned verdict wearing a computed costume, which is the exact
 * failure this wave exists to make impossible.
 */

/** A cell shaped the way `buildCells` emits one. */
function cell(overrides = {}) {
  return {
    id: "vault-core:correctness",
    surface: "vault-core",
    surfaceLabel: "Vault core",
    dimension: "correctness",
    dimensionLabel: "Correctness",
    lane: "per-pr",
    assessment: "solid",
    state: "passed",
    owners: [{ owner: "packages/vault/src/thing.test.ts" }],
    ...overrides,
  };
}

const MATRIX = {
  notes: { "vault-core.correctness": "Tracked under #781." },
  trackingIssues: {
    781: { url: "https://example.invalid/781", state: "open" },
  },
};

describe("computeVerdict", () => {
  test("with no run evidence the verdict is no-evidence, never green", () => {
    const verdict = computeVerdict({
      cells: [cell()],
      summary: {},
      evidenceCount: 0,
    });
    expect(verdict.level).toBe("no-evidence");
    expect(verdict.reasons.join(" ")).toContain("no lane reported a result");
  });

  test("every cell green with live evidence is shippable", () => {
    const verdict = computeVerdict({
      cells: [cell(), cell({ id: "web:journey", assessment: "partial" })],
      summary: { unhandledErrors: 0 },
      evidenceCount: 4,
    });
    expect(verdict.level).toBe("shippable");
  });

  test("SABOTAGE: one red cell flips shippable to red", () => {
    const before = computeVerdict({
      cells: [cell(), cell({ id: "web:journey" })],
      summary: {},
      evidenceCount: 4,
    });
    const after = computeVerdict({
      cells: [cell(), cell({ id: "web:journey", state: "failed" })],
      summary: {},
      evidenceCount: 4,
    });
    expect(before.level).toBe("shippable");
    expect(after.level).toBe("red");
    expect(after.counts.red).toBe(1);
    expect(after.reasons).toContain("1 red cell(s)");
  });

  test("SABOTAGE: a deleted lane leaves a grey cell and degrades the verdict", () => {
    const verdict = computeVerdict({
      cells: [cell(), cell({ id: "web:journey", state: "lane-did-not-run" })],
      summary: {},
      evidenceCount: 4,
    });
    expect(verdict.level).toBe("degraded");
    expect(verdict.counts.grey).toBe(1);
  });

  test("an infra mismatch counts as red, not as an absence", () => {
    const verdict = computeVerdict({
      cells: [cell({ state: "infra-mismatch" })],
      summary: {},
      evidenceCount: 2,
    });
    expect(verdict.level).toBe("red");
    expect(verdict.counts.grey).toBe(0);
  });

  test("a registered named absence does not by itself degrade the verdict", () => {
    const verdict = computeVerdict({
      cells: [cell(), cell({ id: "web:journey", state: "expected-grey" })],
      summary: {},
      evidenceCount: 3,
    });
    expect(verdict.level).toBe("shippable");
    expect(verdict.counts.expectedGrey).toBe(1);
  });

  test("floors and jobs reach the verdict, not only cells", () => {
    expect(
      computeVerdict({
        cells: [cell()],
        summary: {},
        evidenceCount: 1,
        coverageBelowFloor: ["packages/vault"],
      }).level
    ).toBe("red");
    expect(
      computeVerdict({
        cells: [cell()],
        summary: {},
        evidenceCount: 1,
        mutationRows: [{ scope: "packages/vault", score: 60, floor: 97 }],
      }).reasons.join(" ")
    ).toContain("mutation under floor");
    expect(
      computeVerdict({
        cells: [cell()],
        summary: { failedJobs: ["mobile-e2e-ios"] },
        evidenceCount: 1,
      }).reasons.join(" ")
    ).toContain("mobile-e2e-ios");
  });
});

describe("verdictDelta", () => {
  test("with no prior night the direction is unknown, never flattering", () => {
    const delta = verdictDelta({ level: "red", counts: { red: 3, grey: 0 } });
    expect(delta.direction).toBe("unknown");
    expect(delta.priorLabel).toBeNull();
  });

  test("more red than last night regresses; less improves", () => {
    const history = [
      { label: "2026-08-19", cellsFailed: 1, cellsMissing: 0 },
      { label: "2026-08-20", cellsFailed: 1, cellsMissing: 0, verdict: "red" },
    ];
    expect(
      verdictDelta({ counts: { red: 3, grey: 0 } }, history)
    ).toMatchObject({
      direction: "regressed",
      priorLabel: "2026-08-20",
      priorLevel: "red",
      deltas: { red: 2, grey: 0 },
    });
    expect(
      verdictDelta({ counts: { red: 0, grey: 0 } }, history).direction
    ).toBe("improved");
    expect(
      verdictDelta({ counts: { red: 1, grey: 0 } }, history).direction
    ).toBe("unchanged");
  });
});

describe("severityFor", () => {
  test("a solid cell going red is S1; any other red is S2", () => {
    expect(severityFor({ assessment: "solid", state: "failed" })).toBe("S1");
    expect(severityFor({ assessment: "partial", state: "failed" })).toBe("S2");
    expect(severityFor({ assessment: "gap", state: "infra-mismatch" })).toBe(
      "S2"
    );
  });

  test("lane death is S2; an absence that was already there is S3", () => {
    expect(severityFor({ state: "missing", newlyGrey: true })).toBe("S2");
    expect(severityFor({ state: "missing", newlyGrey: false })).toBe("S3");
    expect(severityFor({ state: "stale" })).toBe("S3");
  });

  test("a pinned standing finding is S4", () => {
    expect(severityFor({ state: "open", pinned: true })).toBe("S4");
  });
});

describe("buildAttentionQueue", () => {
  test("green cells never enter the queue", () => {
    expect(
      buildAttentionQueue({ cells: [cell()], matrix: MATRIX })
    ).toStrictEqual([]);
  });

  test("SABOTAGE: a newly-grey cell is picked up, ranked S2, with its owner", () => {
    const queue = buildAttentionQueue({
      cells: [cell(), cell({ id: "web:journey", state: "lane-did-not-run" })],
      matrix: MATRIX,
      newlyGreyIds: ["web:journey"],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: "web:journey",
      kind: "grey",
      severity: "S2",
      isNew: true,
      owner: "packages/vault/src/thing.test.ts",
    });
  });

  test("each entry carries the tracking-issue hook its matrix note cites", () => {
    const queue = buildAttentionQueue({
      cells: [cell({ state: "missing" })],
      matrix: MATRIX,
    });
    expect(queue[0]).toMatchObject({
      trackingIssue: 781,
      trackingUrl: "https://example.invalid/781",
    });
  });

  test("a cell with no cited issue says so rather than inventing one", () => {
    const queue = buildAttentionQueue({
      cells: [cell({ state: "missing" })],
      matrix: { notes: {}, trackingIssues: {} },
    });
    expect(queue[0].trackingIssue).toBeNull();
  });

  test("ranking is severity first, then new, then worst state, then id", () => {
    const queue = buildAttentionQueue({
      cells: [
        cell({ id: "a:x", state: "missing" }),
        cell({ id: "b:x", state: "owner-silent" }),
        cell({ id: "c:x", state: "failed", assessment: "partial" }),
        cell({ id: "d:x", state: "failed", assessment: "solid" }),
        cell({ id: "e:x", state: "stale" }),
      ],
      matrix: MATRIX,
      newlyGreyIds: ["b:x"],
    });
    expect(queue.map((entry) => entry.id)).toStrictEqual([
      "d:x",
      "c:x",
      "b:x",
      "a:x",
      "e:x",
    ]);
  });

  test("the fuzz register surfaces as standing pinned findings", () => {
    const queue = buildAttentionQueue({
      cells: [],
      matrix: MATRIX,
      knownFindings: {
        classes: {
          "wal.closer-roundtrip-rejected": {
            issue: 781,
            status: "open",
            found: "scripts/fuzz/crashers/wal-keys/x.json",
            note: "the codec halves disagree",
          },
        },
      },
    });
    expect(queue[0]).toMatchObject({
      kind: "pinned-finding",
      severity: "S4",
      pinned: true,
      owner: "scripts/fuzz/crashers/wal-keys/x.json",
      trackingIssue: 781,
      why: "the codec halves disagree",
    });
  });

  test("pinned findings sort below live items of the same band", () => {
    const queue = buildAttentionQueue({
      cells: [cell({ id: "z:x", state: "stale" })],
      matrix: MATRIX,
      knownFindings: { classes: { "wal.thing": { issue: 781 } } },
    });
    expect(queue.map((entry) => entry.pinned)).toStrictEqual([false, true]);
  });
});

describe("attentionQueueForIssue", () => {
  test("only S1/S2 ride into the auto-filed nightly issue", () => {
    const queue = buildAttentionQueue({
      cells: [
        cell({ id: "a:x", state: "failed" }),
        cell({ id: "b:x", state: "missing" }),
      ],
      matrix: MATRIX,
    });
    const forIssue = attentionQueueForIssue(queue);
    expect(forIssue.map((entry) => entry.id)).toStrictEqual(["a:x"]);
    expect(forIssue[0]).toMatchObject({
      severity: "S1",
      owner: "packages/vault/src/thing.test.ts",
    });
  });

  test("the issue body is capped so a bad night stays readable", () => {
    const queue = Array.from({ length: 40 }, (_, index) => ({
      id: `cell-${index}`,
      severity: "S2",
      kind: "red",
      title: "x",
      owner: "o",
      trackingIssue: null,
      why: "w",
    }));
    expect(attentionQueueForIssue(queue)).toHaveLength(10);
    expect(attentionQueueForIssue(queue, 3)).toHaveLength(3);
  });
});

describe("issueNumbersInNote", () => {
  test("reads the issue numbers a matrix note cites, in order", () => {
    expect(issueNumbersInNote("Tracked under #781 (originally #656).")).toEqual(
      [781, 656]
    );
    expect(issueNumbersInNote(undefined)).toEqual([]);
  });
});
