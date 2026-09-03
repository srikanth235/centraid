import { describe, expect, it } from "vitest";

import type { InsightsSummary } from "../screen-contracts.js";
import { webBars } from "./insights-model.js";

const GENERATED_AT = Date.UTC(2026, 5, 10, 12, 0, 0);
const day = (offset: number): string =>
  new Date(GENERATED_AT + offset * 86_400_000).toISOString().slice(0, 10);

const summary: InsightsSummary = {
  attention: {
    costUsd: 2,
    key: "a1",
    kind: "top_source",
    kindLabel: "Automation",
    label: "Daily Digest",
    share: 0.59,
  },
  byEffort: [{ costUsd: 0.8, effort: "high", runs: 4, tokens: 7000 }],
  byHarness: [
    { costUsd: 2.5, harness: "claude-code", runs: 7, tokens: 11_000 },
  ],
  byModel: [
    { costUsd: 1.1, model: "claude-opus-4-8", runs: 7, tokens: 11_000 },
  ],
  bySource: [
    {
      costUsd: 2,
      key: "a1",
      kind: "automation",
      label: "Daily Digest",
      runs: 6,
      tokens: 8000,
    },
    {
      costUsd: 0.3,
      key: "c1",
      kind: "chat",
      label: "Chat",
      runs: 2,
      tokens: 3000,
    },
  ],
  daily: [
    {
      costUsd: 0.1,
      date: day(-29),
      failedCostUsd: 0,
      failedRuns: 0,
      runs: 2,
      tokens: 1000,
    },
    {
      costUsd: 0.4,
      date: day(-1),
      failedCostUsd: 0.2,
      failedRuns: 2,
      runs: 5,
      tokens: 4000,
    },
    {
      costUsd: 0.2,
      date: day(0),
      failedCostUsd: 0,
      failedRuns: 0,
      runs: 3,
      tokens: 2000,
    },
  ],
  generatedAt: GENERATED_AT,
  peakDay: {
    costUsd: 0.4,
    date: day(-1),
    tokens: 4000,
    topSources: [
      {
        costUsd: 0.4,
        key: "a1",
        kind: "automation",
        label: "Daily Digest",
        tokens: 4000,
      },
    ],
  },
  kpis: {
    appsTouched: 7,
    estimatedCostUsd: 1.3,
    failedCostUsd: 0.4,
    failedRuns: 2,
    forecastCostUsd: 5.1,
    generations: 42,
    harnessReportedCostUsd: 2.1,
    hydrationTokens: 1024,
    retries: 3,
    totalCostUsd: 3.4,
    totalTokens: 128_000,
    unpricedRuns: 1,
    unreportedRuns: 0,
  },
  recent: [
    {
      costUsd: 0.05,
      effort: "high",
      harness: "claude-code",
      hydrationTokens: 512,
      kind: "chat",
      label: "A chat run",
      ok: true,
      runId: "r1",
      startedAt: GENERATED_AT,
      tokens: 500,
    },
    {
      automationRef: "app/x",
      costUsd: 0.02,
      hydrationTokens: 0,
      kind: "automation",
      label: "A failed run",
      ok: false,
      runId: "r2",
      startedAt: GENERATED_AT,
      tokens: 200,
    },
  ],
  windowDays: 30,
};

describe("screens/InsightsScreen — folding the rollup into columns", () => {
  it("folds by calendar offset, so a quiet week does not slide the busy days", () => {
    const bars = webBars(summary, 30, false);
    expect(bars).toHaveLength(30);
    expect(bars[0]?.ok).toBeGreaterThan(0);
    expect(bars[1]?.ok).toBe(0);
    expect(bars.at(-1)?.label).toBe("10 Jun · $0.20 · 3 runs");
  });

  it("draws SPEND, so a cheap busy day cannot outrank an expensive quiet one", () => {
    const bars = webBars(summary, 30, false);
    const height = (bar: { ok: number; fail?: number }): number =>
      bar.ok + (bar.fail ?? 0);
    expect(height(bars.at(-2)!)).toBe(100);
    expect(height(bars.at(-1)!)).toBe(50);
    expect(bars.every((b) => height(b) >= 0 && height(b) <= 100)).toBe(true);
  });

  it("folds only on the compact form factor, and says the span it folded", () => {
    const folded = webBars(summary, 90, true);
    expect(folded).toHaveLength(10);
    expect(folded[0]?.label).toContain(" – ");
    expect(webBars(summary, 90, false)).toHaveLength(90);
  });
});
