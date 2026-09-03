/* oxlint-disable import/first -- vi.mock is hoisted; subject imports follow */
import { describe, expect, it, vi } from "vitest";

vi.mock(import("../../lib/gateway") as Promise<unknown>, () => ({
  apiHeaders: () => ({}),
  authHeader: () => ({}),
  fetchJson: () => Promise.reject(new Error("not reached")),
  requireGatewayBase: () => Promise.resolve("http://127.0.0.1:9"),
}));

import { insightCsvFilename, insightRollupCsv } from "@centraid/design/blocks";

import { healthLineFor } from "../../kit/components/health-line";
import type {
  GatewayHealth,
  InsightsSummary,
  InsightsActivityRow,
} from "../../lib/insights";
import {
  mobileGatewayFacts,
  insightsHealth,
  nothingRan,
  originActivityHealth,
  unhealthyComponents,
  uptimeSentence,
} from "./insights-model";

const DAY_MS = 86_400_000;
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

describe("the gateway facts", () => {
  it("reports only what the health snapshot measures", () => {
    const facts = mobileGatewayFacts(healthOf());
    expect(facts.map((fact) => fact.key)).toStrictEqual([
      "uptime",
      "memory",
      "components",
      "outbox",
    ]);
    expect(facts[0]?.value).toBe("21d 0h");
    expect(facts[2]?.value).toBe("2 of 2 healthy");
  });

  it("names WHICH component is unhealthy, so the bad news has a subject", () => {
    const sick = healthOf({
      components: [
        { component: "storage", errorCount: 0, status: "ok" },
        { component: "outbox", errorCount: 3, status: "error" },
      ],
    });
    expect(unhealthyComponents(sick)).toBe("outbox");
    expect(unhealthyComponents(healthOf())).toBeUndefined();
    const components = mobileGatewayFacts(sick).find(
      (fact) => fact.key === "components"
    );
    expect(components?.value).toBe("1 of 2 healthy");
    expect(components?.net).toBe(true);
    expect(components?.note).toBe("Not healthy: outbox.");
    expect(
      mobileGatewayFacts(healthOf()).find((fact) => fact.key === "components")
        ?.note
    ).toBeUndefined();
  });

  it("never invents a disk figure or a shared-compute roster", () => {
    const labels = mobileGatewayFacts(healthOf()).map((fact) => fact.key);
    expect(labels).not.toContain("disk");
    expect(labels).not.toContain("compute shared");
  });

  it("adds the latency facts only when the gateway reports them", () => {
    const facts = mobileGatewayFacts(
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
    const facts = mobileGatewayFacts(
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
    expect(healthLineFor("error", copy).text).toBe("This page could not load");
    expect(healthLineFor("empty", copy).text).toBe("Nothing to attend to");
  });
});

describe("empty and export", () => {
  it("keeps Origin Activity's standing line about runs, not the machine", () => {
    const copy = originActivityHealth(
      summaryOf({ kpis: { ...summaryOf().kpis, generations: 3 } })
    );
    expect(copy.detail).toBe("3 runs in this window.");
    expect(`${copy.label} ${copy.detail}`).not.toMatch(
      /gateway|daemon|replica|component/iu
    );
    expect(healthLineFor("loading", originActivityHealth(undefined)).text).toBe(
      "Reading vault activity"
    );
  });

  it("is empty only when the window holds no runs and no recent tail", () => {
    expect(nothingRan(summaryOf())).toBe(true);
    expect(nothingRan(summaryOf({ recent: [runOf()] }))).toBe(false);
    expect(
      nothingRan(summaryOf({ kpis: { ...summaryOf().kpis, generations: 1 } }))
    ).toBe(false);
  });

  it("exports the numbers the chart is drawn from, in the chart's order", () => {
    expect(
      insightRollupCsv(
        summaryOf({
          daily: [
            {
              costUsd: 1.5,
              date: "2026-08-12",
              failedCostUsd: 0.5,
              failedRuns: 1,
              runs: 3,
              tokens: 400,
            },
            {
              costUsd: 0,
              date: "2026-08-13",
              failedCostUsd: 0,
              failedRuns: 0,
              runs: 0,
              tokens: 0,
            },
          ],
        })
      )
    ).toBe(
      [
        "date,runs,failed_runs,tokens,cost_usd,failed_cost_usd",
        "2026-08-12,3,1,400,1.5000,0.5000",
        "2026-08-13,0,0,0,0.0000,0.0000",
      ].join("\n")
    );
  });

  it("names the file after the window it holds", () => {
    expect(insightCsvFilename(90)).toBe("centraid-analytics-90d.csv");
  });
});
