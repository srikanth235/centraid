import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  baseMatrix,
  CAPTURED_MS,
  FRESH_WINDOW_HOURS,
  JOIN_OWNER,
  JOURNEY_OWNER,
  makeFixtureRoot,
  OWNER,
  runGenerate,
  vitestReport,
  writeJson,
} from "./report-fixture-root.mjs";

/**
 * #839 Wave 5 — the report-v2 briefing, driven end to end through the real
 * generator against a synthetic root.
 *
 * The unit suites (`report-verdict.test.mjs`, `report-grids.test.mjs`) prove
 * the arithmetic. This file proves the WIRING: that the verdict on the page is
 * the one computed from the cells the page renders, that a lane deleted from
 * the fixture turns grey instead of leaving, and that the attention queue and
 * the auto-file payload in `summary.json` see the same regression.
 */

/** Evidence for every owner the fixture registries name. */
function allGreenVitest(atMs = CAPTURED_MS) {
  return {
    startTime: atMs,
    testResults: [OWNER, JOIN_OWNER, JOURNEY_OWNER].map((name) => ({
      name,
      status: "passed",
      startTime: atMs,
      endTime: atMs + 1_000,
      assertionResults: [],
    })),
  };
}

/** Run the generator with fixture evidence and a century-wide freshness window. */
function runWith(root, report, extra = []) {
  const vitestPath = writeJson(root, "in/vitest.json", report);
  return runGenerate(root, [
    "--vitest",
    vitestPath,
    "--max-age-hours",
    FRESH_WINDOW_HOURS,
    ...extra,
  ]);
}

describe("the verdict strip", () => {
  test("with no run evidence at all the verdict is the honest no-evidence state", () => {
    const result = runGenerate(makeFixtureRoot());
    expect(result.status).toBe(0);
    expect(result.summary.verdict).toBe("no-evidence");
    expect(result.html).toContain("verdict-no-evidence");
    expect(result.html).toContain("No run evidence");
    expect(result.html).toContain("no lane reported a result into this render");
  });

  test("every owned cell green makes the verdict shippable", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.summary.verdict).toBe("shippable");
    expect(result.html).toContain("verdict-shippable");
  });

  test("SABOTAGE: reddening one fixture cell flips the verdict to red", () => {
    const root = makeFixtureRoot();
    const report = allGreenVitest();
    report.testResults[0].status = "failed";
    report.testResults[0].assertionResults = [
      { status: "failed", title: "t", failureMessages: ["boom"] },
    ];
    const result = runWith(root, report);
    expect(result.summary.verdict).toBe("red");
    expect(result.html).toContain("verdict-red");
    expect(result.summary.verdictReasons.join(" ")).toContain("1 red cell(s)");
  });

  test("the verdict is a whitelisted history field, so tomorrow can read it", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.html).toContain('"verdict":"shippable"');
  });

  test("with no durable history the delta says so instead of flattering", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.summary.verdictDirection).toBe("unknown");
    expect(result.html).toContain("no prior nightly in the durable history");
  });
});

describe("the attention queue", () => {
  test("SABOTAGE: a cell that goes grey against last night is picked up as new", () => {
    const root = makeFixtureRoot();
    // Last night this cell had evidence: it is absent from the prior run's
    // missingCellIds, so tonight's silence is a regression, not a carry-over.
    writeJson(root, "history/index.json", {
      entries: [
        {
          slug: "2026-08-20",
          summary: {
            cellsFailed: 0,
            cellsMissing: 0,
            missingCellIds: [],
            failedCellIds: [],
            verdict: "shippable",
          },
        },
      ],
    });
    const report = allGreenVitest();
    report.testResults = report.testResults.filter(
      (file) => file.name !== OWNER
    );
    const result = runWith(root, report, [
      "--history",
      path.join(root, "history"),
    ]);
    const queued = result.summary.attentionQueue;
    expect(queued.map((entry) => entry.id)).toContain("vault:correctness");
    expect(queued[0]).toMatchObject({ severity: "S2", owner: OWNER });
    expect(result.html).toContain("new tonight");
    expect(result.summary.attentionQueueBands.S2).toBeGreaterThan(0);
  });

  test("a grey cell with no prior night is S3, not a fake regression", () => {
    const root = makeFixtureRoot();
    const report = allGreenVitest();
    report.testResults = report.testResults.filter(
      (file) => file.name !== OWNER
    );
    const result = runWith(root, report);
    expect(result.summary.attentionQueueBands).toMatchObject({ S2: 0, S3: 1 });
    // S3 is deliberately not auto-filed — last night's issue already has it.
    expect(result.summary.attentionQueue).toStrictEqual([]);
  });

  test("every entry carries its owner path so the queue is actionable", () => {
    const root = makeFixtureRoot();
    const result = runGenerate(root);
    expect(result.html).toContain(OWNER);
    expect(result.html).toContain("Attention queue");
  });

  test("the fuzz register's standing findings are pinned into the queue", () => {
    const root = makeFixtureRoot();
    writeJson(root, "scripts/fuzz/known-findings.json", {
      classes: {
        "wal-keys.fixture-divergence": {
          issue: 839,
          status: "open",
          found: "scripts/fuzz/crashers/wal-keys/fixture.json",
          note: "the two halves of the codec disagree",
        },
      },
    });
    const result = runWith(root, allGreenVitest());
    expect(result.summary.attentionQueueBands.S4).toBe(1);
    expect(result.html).toContain("the two halves of the codec disagree");
    expect(result.html).toContain("pinned");
  });
});

describe("grids E, F, G and the consent ledger", () => {
  test("all four render, derived from the matrix registries", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.html).toContain("Join laws and simulation");
    expect(result.html).toContain("Adversary panel");
    expect(result.html).toContain("Journeys · budget vs actual");
    expect(result.html).toContain("Consent ledger");
    expect(result.summary.joinLawCounts).toMatchObject({
      scripted: 1,
      simulation: 1,
      passed: 2,
    });
    expect(result.summary.journeyCounts).toMatchObject({
      journeys: 1,
      passed: 1,
    });
    expect(result.summary.consentLedgerCounts).toMatchObject({ layers: 8 });
  });

  test("the journey grid shows its runner's budget against the measured actual", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.html).toContain("budget 4m");
    expect(result.html).toContain("actual 1.0s");
  });

  test("ZERO-GREY SABOTAGE: deleting a lane's evidence renders grey, never absent", () => {
    const root = makeFixtureRoot();
    const withLane = runWith(root, allGreenVitest());
    const report = allGreenVitest();
    report.testResults = report.testResults.filter(
      (file) => file.name !== JOIN_OWNER
    );
    const withoutLane = runWith(root, report);
    // The row survives — same count — and reports missing instead of passing.
    expect(withoutLane.summary.joinLawCounts.scripted).toBe(
      withLane.summary.joinLawCounts.scripted
    );
    expect(withoutLane.summary.joinLawCounts.simulation).toBe(
      withLane.summary.joinLawCounts.simulation
    );
    expect(withLane.summary.joinLawCounts.passed).toBe(2);
    expect(withoutLane.summary.joinLawCounts.passed).toBe(0);
    expect(withoutLane.html).toContain("Fixture scripted law");
    expect(withoutLane.html).toContain("Fixture simulation law");
  });

  test("ZERO-GREY SABOTAGE: a journey with no evidence keeps its row", () => {
    const root = makeFixtureRoot();
    const report = allGreenVitest();
    report.testResults = report.testResults.filter(
      (file) => file.name !== JOURNEY_OWNER
    );
    const result = runWith(root, report);
    expect(result.summary.journeyCounts).toMatchObject({
      journeys: 1,
      passed: 0,
      missing: 1,
    });
    expect(result.html).toContain("Fixture flow");
    expect(result.html).toContain("no complete run evidence");
  });

  test("the adversary panel counts the real fuzz corpus and the engine registry", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.summary.adversaryCounts.fuzzTargets).toBeGreaterThan(0);
    expect(result.summary.adversaryCounts.fuzzCorpusSeeds).toBeGreaterThan(0);
    expect(result.summary.adversaryCounts.mutationSeeds).toBeGreaterThan(0);
    // The fixture engine declares no property flow, so the hole is visible.
    expect(result.summary.adversaryCounts.enginesWithoutProperty).toBe(1);
  });

  test("NEVER FAKE HISTORY: with no durable series the sparkline slot is empty", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.html).toContain("no history yet");
  });
});

describe("the detail shelf survives beneath the briefing", () => {
  test("every section report v1 rendered is still on the page", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    for (const heading of [
      "User-facing qualities",
      "Blueprint app × shared engine",
      "Blueprint app × seat",
      "Blueprint app × designed state",
      "Surface × quality dimension",
      "Coverage vs ratchet floor",
      "Mutation vs ratchet floor",
      "Per-package wall clock",
      "Slowest 10 test files · bloat watch",
      "Environment-gated matrix owners",
      "Skipped and environment-gated test debt",
      "Playwright flake rate",
      "Absolute weakness signals",
      "Open field-quality observations",
      "Nightly performance and scale trends",
    ]) {
      expect(result.html).toContain(heading);
    }
  });

  test("the briefing sits above the detail shelf, not inside it", () => {
    const result = runWith(makeFixtureRoot(), allGreenVitest());
    expect(result.html.indexOf("Attention queue")).toBeLessThan(
      result.html.indexOf("Surface × quality dimension")
    );
    expect(result.html.indexOf('class="verdict')).toBeLessThan(
      result.html.indexOf("Attention queue")
    );
  });
});

describe("the auto-file payload", () => {
  test("summary.json carries the S1/S2 queue the nightly issue body renders", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      path.join(root, OWNER),
      "test('owned behaviour', () => {});\n"
    );
    const report = allGreenVitest();
    report.testResults[0].status = "failed";
    report.testResults[0].assertionResults = [
      { status: "failed", title: "t", failureMessages: ["boom"] },
    ];
    const result = runWith(root, report);
    expect(result.summary.attentionQueue[0]).toMatchObject({
      severity: "S1",
      kind: "red",
      owner: OWNER,
    });
    expect(result.summary.verdict).toBe("red");
  });
});

describe("the fixture harness itself", () => {
  test("vitestReport still shapes a single owner result", () => {
    expect(vitestReport(CAPTURED_MS).testResults[0]).toMatchObject({
      name: OWNER,
      status: "passed",
    });
    expect(baseMatrix().joinLaws).toHaveLength(2);
  });
});
