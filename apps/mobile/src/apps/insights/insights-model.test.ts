// The words and numbers the Analytics place puts on screen (#765, spec §5).
//
// Rendering is tested next door; this pins the arithmetic and the copy, because
// every line below is a claim about work that already happened:
//
//  - the chart folds the rollup by CALENDAR OFFSET, so a quiet stretch stays
//    quiet instead of sliding the busy days left
//  - every column carries ONE segment: the rollup has no per-day outcome split,
//    so a failed segment would be invented
//  - a source with no runs in the window is absent, not zeroed
//  - spend says "at least" whenever a run in the window could not be priced
//  - the standing line reports what succeeded and how long the machine has been
//    up, and carries NO median duration (nothing records one) and no verb
//  - the gateway facts are only what the health snapshot actually reports —
//    never a disk figure, never a shared-compute roster

/* oxlint-disable import/first -- vi.mock is hoisted; subject imports follow */
import { describe, expect, it, vi } from "vitest";

// The formatters this module uses live beside the gateway client, and that
// module reaches react-native. Mocking the transport (never the formatters)
// keeps this test pure — the same one-liner `lib/insights.test.ts` writes.
vi.mock(import("../../lib/gateway") as Promise<unknown>, () => ({
  apiHeaders: () => ({}),
  authHeader: () => ({}),
  fetchJson: () => Promise.reject(new Error("not reached")),
  requireGatewayBase: () => Promise.resolve("http://127.0.0.1:9"),
}));

import type { InsightsSummary, InsightsActivityRow } from "../../lib/insights";
import {
  axisLabels,
  buildBars,
  columnCount,
  harnessBreakdown,
  isWindowDays,
  pricingLine,
  recentRows,
  runsMeta,
  peakNote,
  sourceFacts,
  sourceMeta,
  spendFacts,
  spendFigure,
  windowChips,
} from "./insights-model";

const DAY_MS = 86_400_000;
/** The plot's column ceiling on this surface (`BarsBlock.styles.MAX_COLUMNS`),
 *  repeated here because that module pulls the renderer in. The screen passes
 *  the real constant; this pins the fold at the same ceiling. */
const COLUMNS = 31;
/** A fixed anchor so the fold's arithmetic is readable: 2026-08-13T00:00:00Z. */
const ANCHOR = Date.parse("2026-08-13T00:00:00.000Z");

function summaryOf(over: Partial<InsightsSummary> = {}): InsightsSummary {
  return {
    bySource: [],
    byEffort: [],
    byHarness: [],
    byModel: [],
    daily: [],
    generatedAt: ANCHOR,
    kpis: {
      appsTouched: 2,
      estimatedCostUsd: 0,
      failedCostUsd: 0,
      failedRuns: 0,
      forecastCostUsd: 0,
      generations: 0,
      harnessReportedCostUsd: 0,
      hydrationTokens: 0,
      quotaTokens: 0,
      retries: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      unpricedRuns: 0,
      unreportedRuns: 0,
    },
    recent: [],
    windowDays: 30,
    ...over,
  };
}

function runOf(over: Partial<InsightsActivityRow> = {}): InsightsActivityRow {
  return {
    costUsd: 0.42,
    hydrationTokens: 0,
    kind: "automation",
    label: "Tidy downloads",
    ok: true,
    runId: "run-1",
    startedAt: ANCHOR,
    tokens: 1200,
    ...over,
  };
}

/** `YYYY-MM-DD` for a day offset from the anchor. */
function dayAt(daysAgo: number): string {
  return new Date(ANCHOR - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

describe("the window picker", () => {
  it("offers three windows and marks the live one", () => {
    expect(windowChips(30)).toStrictEqual([
      { id: "7", label: "7 days", on: false },
      { id: "30", label: "30 days", on: true },
      { id: "90", label: "90 days", on: false },
    ]);
  });

  it("only accepts a stored window this page can get back out of", () => {
    expect(isWindowDays(7)).toBe(true);
    expect(isWindowDays(45)).toBe(false);
    expect(isWindowDays("30")).toBe(false);
    expect(isWindowDays(undefined)).toBe(false);
  });

  it("marks the axis with real dates rather than relative words", () => {
    // A column is a day, and a day has a name: "30 days ago · halfway" gave a
    // reader nothing they could check a spike against (#775).
    expect(axisLabels(summaryOf(), 7, ANCHOR)).toStrictEqual([
      "7 Aug",
      "10 Aug",
      "today",
    ]);
    expect(axisLabels(summaryOf(), 90, ANCHOR)[0]).toBe("16 May");
  });
});

describe("the runs chart", () => {
  it("draws ONE COLUMN PER DAY up to the plot's ceiling (#775)", () => {
    // The chart never samples a window to ten columns: one expensive afternoon
    // must not be averaged across three ordinary days.
    expect(
      buildBars(summaryOf(), 7, ANCHOR, columnCount(7, COLUMNS))
    ).toHaveLength(7);
    expect(
      buildBars(summaryOf(), 30, ANCHOR, columnCount(30, COLUMNS))
    ).toHaveLength(30);
    // Only the window the plot genuinely cannot carry still folds.
    expect(
      buildBars(
        summaryOf({ windowDays: 90 }),
        90,
        ANCHOR,
        columnCount(90, COLUMNS)
      )
    ).toHaveLength(31);
  });

  it("carries one segment per column — nothing splits runs by outcome", () => {
    const bars = buildBars(
      summaryOf({
        daily: [{ costUsd: 1, date: dayAt(0), runs: 9, tokens: 10 }],
        kpis: { ...summaryOf().kpis, failedRuns: 4, generations: 9 },
      }),
      7,
      ANCHOR,
      COLUMNS
    );
    expect(bars.every((bar) => bar.failed === 0)).toBe(true);
  });

  it("folds by calendar offset, so a quiet stretch stays quiet", () => {
    // Two days of the ten-day window did work; the eight silent days sit
    // between them and must not collapse.
    const bars = buildBars(
      summaryOf({
        daily: [
          { costUsd: 0.5, date: dayAt(9), runs: 4, tokens: 0 },
          { costUsd: 1, date: dayAt(0), runs: 8, tokens: 0 },
        ],
      }),
      10,
      ANCHOR,
      10
    );
    expect(bars.map((bar) => bar.succeeded)).toStrictEqual([
      50, 0, 0, 0, 0, 0, 0, 0, 0, 100,
    ]);
  });

  it("draws SPEND, so a cheap busy day cannot outrank an expensive quiet one", () => {
    const bars = buildBars(
      summaryOf({
        daily: [
          { costUsd: 4, date: dayAt(1), runs: 1, tokens: 0 },
          { costUsd: 0.004, date: dayAt(0), runs: 40, tokens: 0 },
        ],
      }),
      2,
      ANCHOR,
      2
    );
    // …and a day that cost something is never drawn as nothing.
    expect(bars.map((bar) => bar.succeeded)).toStrictEqual([100, 1]);
  });

  it("names each column with its date, its cost and its volume", () => {
    const bars = buildBars(
      summaryOf({
        daily: [{ costUsd: 0.25, date: dayAt(0), runs: 1, tokens: 0 }],
      }),
      10,
      ANCHOR,
      10
    );
    expect(bars.at(-1)?.label).toBe("13 Aug · $0.25 · 1 run");
    expect(bars[0]?.label).toBe("4 Aug · $0.00 · 0 runs");
  });

  it("falls back to the read's own clock when the rollup did not stamp itself", () => {
    const bars = buildBars(
      summaryOf({
        daily: [{ costUsd: 3, date: dayAt(0), runs: 3, tokens: 0 }],
        generatedAt: 0,
      }),
      10,
      ANCHOR,
      10
    );
    expect(bars.at(-1)?.succeeded).toBe(100);
  });

  it("names the peak day, which is the only value the plot can state", () => {
    expect(
      peakNote(
        summaryOf({
          peakDay: {
            costUsd: 2.4,
            date: dayAt(2),
            tokens: 12_000,
            topSources: [
              {
                costUsd: 2.4,
                key: "tidy/downloads",
                kind: "automation",
                label: "Tidy downloads",
                tokens: 12_000,
              },
            ],
          },
        })
      )
    ).toBe("Busiest 11 Aug: $2.40 · 12k tokens · mostly Tidy downloads");
    // A window with no peak says nothing rather than inventing one.
    expect(peakNote(summaryOf())).toBeUndefined();
  });
});

describe("the section counts", () => {
  it("states the window's failures once, on the Runs count line", () => {
    const summary = summaryOf({
      kpis: { ...summaryOf().kpis, failedRuns: 9, generations: 1284 },
    });
    expect(runsMeta(summary)).toBe("1,284 runs · 9 failed");
    expect(sourceMeta(summary)).toBe("1,284 runs");
  });

  it("says nothing about failures when there were none", () => {
    expect(
      runsMeta(summaryOf({ kpis: { ...summaryOf().kpis, generations: 312 } }))
    ).toBe("312 runs");
  });
});

describe("the by-source facts", () => {
  const busy = summaryOf({
    bySource: [
      {
        costUsd: 2,
        key: "tidy/downloads",
        kind: "automation",
        label: "Tidy downloads",
        runs: 60,
        tokens: 100,
      },
      {
        costUsd: 1,
        key: "chat",
        kind: "chat",
        label: "The assistant",
        runs: 40,
        tokens: 100,
      },
    ],
    kpis: {
      ...summaryOf().kpis,
      forecastCostUsd: 9,
      generations: 100,
      totalCostUsd: 3,
      totalTokens: 200,
    },
  });

  it("reports runs, share and cost per bucket, and omits a bucket with none", () => {
    const facts = sourceFacts(busy);
    expect(facts.map((fact) => fact.key)).toStrictEqual([
      "automations",
      "the assistant",
    ]);
    expect(facts[0]?.value).toBe("60 · 60% · $2.00");
    expect(facts[1]?.value).toBe("40 · 40% · $1.00");
  });

  it("never claims failures it cannot attribute", () => {
    for (const fact of sourceFacts(busy))
      expect(fact.value).not.toContain("failed");
  });

  it("has no median-duration fact — nothing records a duration", () => {
    expect(
      sourceFacts(busy).some((fact) => fact.key.includes("duration"))
    ).toBe(false);
  });

  it("calls spend a floor when a run in the window could not be priced", () => {
    // The figure is promoted out of the fact list (#775) — the floor is stated
    // in its LABEL, where a member reading only the big number still sees it.
    const priced = spendFigure(summaryOf({ kpis: busy.kpis }), 30);
    expect(priced.label).toBe("Spend · 30 days");
    expect(priced.value).toBe("$3.00");
    const floored = spendFigure(
      summaryOf({ kpis: { ...busy.kpis, unpricedRuns: 3 } }),
      30
    );
    expect(floored.label).toBe("At least · 30 days");
    expect(floored.qualifier).toBe("3 unpriced.");
  });

  it("states what the failures cost and how often work was retried", () => {
    const facts = spendFacts(
      summaryOf({
        kpis: {
          ...busy.kpis,
          failedCostUsd: 0.4,
          failedRuns: 2,
          retries: 3,
        },
      })
    );
    const value = (key: string): string | undefined =>
      facts.find((fact) => fact.key === key)?.value;
    expect(value("runs")).toBe("100 · 3 retried");
    expect(value("failed")).toBe("2 · $0.40 spent");
    expect(facts.find((fact) => fact.key === "failed")?.net).toBe(true);
    // A window with no failures says nothing about them.
    expect(
      spendFacts(summaryOf({ kpis: busy.kpis })).some(
        (fact) => fact.key === "failed"
      )
    ).toBe(false);
  });

  it("measures a breakdown against the whole, and falls back to tokens", () => {
    const spend = harnessBreakdown(
      summaryOf({
        byHarness: [
          { costUsd: 1, harness: "codex", runs: 2, tokens: 100 },
          { costUsd: 3, harness: "claude-code", runs: 6, tokens: 900 },
        ],
      })
    );
    expect(spend.unit).toBe("of spend");
    expect(spend.rows.map((row) => row.weight)).toStrictEqual([1, 3]);
    expect(spend.rows[1]?.value).toBe("$3.00 · 900 · 6 runs");
    // A window where nothing could be priced measures the WHOLE breakdown in
    // tokens rather than mixing two units inside one set of bars.
    const unpriced = harnessBreakdown(
      summaryOf({
        byHarness: [{ costUsd: 0, harness: "codex", runs: 2, tokens: 100 }],
      })
    );
    expect(unpriced.unit).toBe("of tokens");
    expect(unpriced.meta).toBe("sorted by tokens");
  });

  it("states where the money came from, and never calls unknown free", () => {
    expect(
      pricingLine(
        summaryOf({
          kpis: {
            ...busy.kpis,
            estimatedCostUsd: 1,
            harnessReportedCostUsd: 2,
            unpricedRuns: 3,
          },
        })
      )
    ).toBe("$2.00 harness-reported · $1.00 estimated · 3 unpriced.");
    expect(pricingLine(summaryOf())).toBe("No completed runs in this window.");
  });

  it("names the one source that took most of the spend, when there is one", () => {
    const facts = spendFacts(
      summaryOf({
        ...busy,
        attention: {
          costUsd: 2,
          key: "tidy/downloads",
          kind: "top_source",
          kindLabel: "automation",
          label: "Tidy downloads",
          share: 0.66,
        },
      })
    );
    expect(facts.at(-1)?.value).toBe("Tidy downloads · 66% of spend");
  });
});

describe("the recent runs", () => {
  it("says what happened, and takes net on the metadata of a failure", () => {
    const [row] = recentRows(
      summaryOf({
        recent: [
          runOf({
            effort: "medium",
            harness: "codex",
            ok: false,
            tokens: 3400,
          }),
        ],
      })
    );
    expect(row?.title).toBe("Tidy downloads");
    expect(row?.sub).toBe(
      "Failed · Automation · codex · medium · $0.42 · 3.4k tokens"
    );
    expect(row?.net).toBe(true);
  });

  it("offers a destination only for a run that belongs to an automation", () => {
    const rows = recentRows(
      summaryOf({
        recent: [
          runOf({ automationRef: "tidy/downloads" }),
          runOf({
            kind: "chat",
            label: "what did the survey say",
            runId: "r2",
          }),
        ],
      })
    );
    expect(rows[0]?.automationRef).toBe("tidy/downloads");
    expect(rows[1]?.automationRef).toBeUndefined();
  });
});
