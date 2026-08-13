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

import { healthLineFor } from "../../kit/components/health-line";
import type {
  GatewayHealth,
  InsightsSummary,
  InsightsActivityRow,
} from "../../lib/insights";
import {
  axisLabels,
  buildBars,
  csvFilename,
  gatewayFacts,
  insightsCsv,
  insightsHealth,
  isWindowDays,
  nothingRan,
  pricingLine,
  recentRows,
  runsMeta,
  sourceFacts,
  sourceMeta,
  uptimeSentence,
  windowChips,
} from "./insights-model";

const DAY_MS = 86_400_000;
/** The chart's column count on this surface (`BarsBlock.styles.COLUMN_COUNT`),
 *  repeated here because that module pulls the renderer in. The screen passes
 *  the real constant; this pins the fold at the same width. */
const COLUMNS = 10;
/** A fixed anchor so the fold's arithmetic is readable: 2026-08-13T00:00:00Z. */
const ANCHOR = Date.parse("2026-08-13T00:00:00.000Z");

function summaryOf(over: Partial<InsightsSummary> = {}): InsightsSummary {
  return {
    bySource: [],
    byEffort: [],
    byModel: [],
    daily: [],
    generatedAt: ANCHOR,
    kpis: {
      appsTouched: 2,
      estimatedCostUsd: 0,
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

function healthOf(over: Partial<GatewayHealth> = {}): GatewayHealth {
  return {
    components: [
      { component: "storage", errorCount: 0, status: "ok" },
      { component: "outbox", errorCount: 0, status: "ok" },
    ],
    metrics: {
      outboxPending: 0,
      rssBytes: 3 * 1024 * 1024 * 1024,
      uptimeMs: 21 * DAY_MS,
    },
    recentEvents: [],
    startedAt: "2026-07-23T00:00:00.000Z",
    status: "ok",
    uptimeMs: 21 * DAY_MS,
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

  it("re-says the axis when the window moves", () => {
    expect(axisLabels(7)).toStrictEqual(["7 days ago", "halfway", "today"]);
    expect(axisLabels(90)).toStrictEqual(["90 days ago", "halfway", "today"]);
  });
});

describe("the runs chart", () => {
  it("always draws ten columns, whatever the window", () => {
    expect(buildBars(summaryOf(), 7, ANCHOR, COLUMNS)).toHaveLength(10);
    expect(
      buildBars(summaryOf({ windowDays: 90 }), 90, ANCHOR, COLUMNS)
    ).toHaveLength(10);
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
          { costUsd: 0, date: dayAt(9), runs: 4, tokens: 0 },
          { costUsd: 0, date: dayAt(0), runs: 8, tokens: 0 },
        ],
      }),
      10,
      ANCHOR,
      COLUMNS
    );
    expect(bars.map((bar) => bar.succeeded)).toStrictEqual([
      50, 0, 0, 0, 0, 0, 0, 0, 0, 100,
    ]);
  });

  it("names each column for a reader who cannot see it", () => {
    const bars = buildBars(
      summaryOf({
        daily: [{ costUsd: 0, date: dayAt(0), runs: 1, tokens: 0 }],
      }),
      10,
      ANCHOR,
      COLUMNS
    );
    expect(bars.at(-1)?.label).toBe("1 run · today");
    expect(bars[0]?.label).toBe("0 runs · 9 days ago");
  });

  it("falls back to the read's own clock when the rollup did not stamp itself", () => {
    const bars = buildBars(
      summaryOf({
        daily: [{ costUsd: 0, date: dayAt(0), runs: 3, tokens: 0 }],
        generatedAt: 0,
      }),
      10,
      ANCHOR,
      COLUMNS
    );
    expect(bars.at(-1)?.succeeded).toBe(100);
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
      "spend",
      "tokens",
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
    const facts = sourceFacts(
      summaryOf({ kpis: { ...busy.kpis, unpricedRuns: 3 } })
    );
    expect(facts.find((fact) => fact.key === "spend")?.value).toBe(
      "at least $3.00 · $9.00 forecast"
    );
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
    const facts = sourceFacts(
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

describe("the gateway facts", () => {
  it("reports only what the health snapshot measures", () => {
    const facts = gatewayFacts(healthOf());
    expect(facts.map((fact) => fact.key)).toStrictEqual([
      "uptime",
      "memory",
      "components",
      "outbox",
    ]);
    expect(facts[0]?.value).toBe("21d 0h");
    expect(facts[2]?.value).toBe("2 of 2 healthy");
  });

  it("never invents a disk figure or a shared-compute roster", () => {
    const labels = gatewayFacts(healthOf()).map((fact) => fact.key);
    expect(labels).not.toContain("disk");
    expect(labels).not.toContain("compute shared");
  });

  it("adds the latency facts only when the gateway reports them", () => {
    const facts = gatewayFacts(
      healthOf({
        metrics: {
          eventLoopLagP99Ms: 4.2,
          outboxPending: 2,
          rssBytes: 1024,
          storageFsyncMs: 12,
          uptimeMs: DAY_MS,
        },
      })
    );
    expect(facts.map((fact) => fact.key)).toContain("loop lag");
    expect(facts.map((fact) => fact.key)).toContain("storage fsync");
  });

  it("lets the component count be the one fact that can be bad news", () => {
    const facts = gatewayFacts(
      healthOf({
        components: [
          { component: "storage", errorCount: 0, status: "ok" },
          { component: "outbox", errorCount: 3, status: "error" },
        ],
      })
    );
    expect(facts.find((fact) => fact.key === "components")).toMatchObject({
      net: true,
      value: "1 of 2 healthy",
    });
  });
});

describe("the standing line", () => {
  it("says how much succeeded and how long the machine has been up", () => {
    const copy = insightsHealth(
      summaryOf({
        kpis: { ...summaryOf().kpis, failedRuns: 9, generations: 1284 },
      }),
      21 * DAY_MS
    );
    expect(copy.label).toBe("99% of runs succeeded");
    expect(copy.detail).toBe("The gateway has been up for 21 days.");
    expect(healthLineFor("ready", copy)).toStrictEqual({
      text: "99% of runs succeeded · The gateway has been up for 21 days.",
    });
  });

  it("carries no inline verb — this page has nothing to act on", () => {
    const copy = insightsHealth(summaryOf(), 0);
    expect(copy.action).toBeUndefined();
    expect(healthLineFor("ready", copy).action).toBeUndefined();
  });

  it("makes no claim about duration", () => {
    const copy = insightsHealth(summaryOf(), DAY_MS);
    expect(`${copy.label} ${copy.detail}`).not.toContain("duration");
  });

  it("says the coarsest true thing about uptime, or admits it does not know", () => {
    expect(uptimeSentence(DAY_MS)).toBe("The gateway has been up for 1 day.");
    expect(uptimeSentence(2 * 3_600_000)).toBe(
      "The gateway has been up for 2 hours."
    );
    expect(uptimeSentence(undefined)).toBe(
      "This gateway did not report how long it has been up."
    );
  });

  it("falls back to the three generic sentences when nothing was read", () => {
    const copy = insightsHealth(undefined, undefined);
    expect(healthLineFor("loading", copy).text).toBe(
      "Reading from the gateway"
    );
    expect(healthLineFor("error", copy).text).toBe(
      "This page could not load · everything else on the gateway is unaffected."
    );
    expect(healthLineFor("empty", copy).text).toBe(
      "Nothing to attend to · nothing needs you here right now."
    );
  });
});

describe("empty and export", () => {
  it("is empty only when the window holds no runs and no recent tail", () => {
    expect(nothingRan(summaryOf())).toBe(true);
    expect(nothingRan(summaryOf({ recent: [runOf()] }))).toBe(false);
    expect(
      nothingRan(summaryOf({ kpis: { ...summaryOf().kpis, generations: 1 } }))
    ).toBe(false);
  });

  it("exports the numbers the chart is drawn from, in the chart's order", () => {
    expect(
      insightsCsv(
        summaryOf({
          daily: [
            { costUsd: 1.5, date: "2026-08-12", runs: 3, tokens: 400 },
            { costUsd: 0, date: "2026-08-13", runs: 0, tokens: 0 },
          ],
        })
      )
    ).toBe(
      [
        "date,runs,tokens,cost_usd",
        "2026-08-12,3,400,1.5000",
        "2026-08-13,0,0,0.0000",
      ].join("\n")
    );
  });

  it("names the file after the window it holds", () => {
    expect(csvFilename(90)).toBe("centraid-analytics-90d.csv");
  });
});
