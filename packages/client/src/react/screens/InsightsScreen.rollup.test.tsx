import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, test } from "vitest";

import { insightBreakdowns, insightSourceFacts } from "@centraid/design/blocks";

import type { InsightsSummary } from "../screen-contracts.js";
import { webBars, WEB_INSIGHT_WORDS } from "./insights-model.js";
import InsightsScreen from "./InsightsScreen.js";

// Analytics (v9, #765). The assertions are about INTENT, not the old markup:
// one window picker, one chart that is one image, facts in the numeric
// register, and a page that says what it cannot measure instead of drawing it.

// A fixed rollup clock, so the day folding is the same in every timezone the
// suite might run in.
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

function screen(props: Partial<Parameters<typeof InsightsScreen>[0]> = {}) {
  return mount(
    <InsightsScreen
      onWindowDays={() => undefined}
      summary={summary}
      windowDays={30}
      {...props}
    />
  );
}

describe("screens/InsightsScreen — folding the rollup into columns", () => {
  it("folds by calendar offset, so a quiet week does not slide the busy days", () => {
    const bars = webBars(summary, 30, false);
    expect(bars).toHaveLength(30);
    // day(-29) is the window's first day; day(-1)/day(0) are its last.
    expect(bars[0]?.ok).toBeGreaterThan(0);
    expect(bars[1]?.ok).toBe(0);
    expect(bars.at(-1)?.label).toBe("10 Jun · $0.20 · 3 runs");
  });

  it("draws SPEND, so a cheap busy day cannot outrank an expensive quiet one", () => {
    const bars = webBars(summary, 30, false);
    // A column's HEIGHT is its spend share; the outcome split divides that
    // height, so the two segments are read together to compare two days.
    const height = (bar: { ok: number; fail?: number }): number =>
      bar.ok + (bar.fail ?? 0);
    // day(-1) cost the most ($0.40) though day(0) is not far behind in runs.
    expect(height(bars.at(-2)!)).toBe(100);
    expect(height(bars.at(-1)!)).toBe(50);
    expect(bars.every((b) => height(b) >= 0 && height(b) <= 100)).toBe(true);
  });

  it("folds only on the compact form factor, and says the span it folded", () => {
    const folded = webBars(summary, 90, true);
    expect(folded).toHaveLength(10);
    expect(folded[0]?.label).toContain(" – ");
    // Under a pointer a ninety-day window is ninety columns.
    expect(webBars(summary, 90, false)).toHaveLength(90);
  });

  it("omits a source with no runs rather than reporting a zero", () => {
    expect(
      insightSourceFacts({ ...summary, bySource: [] }, WEB_INSIGHT_WORDS)
    ).toStrictEqual([]);
    expect(
      insightSourceFacts(summary, WEB_INSIGHT_WORDS).map((f) => f.key)
    ).toStrictEqual(["automations", "the assistant"]);
  });

  it("measures a fully unpriced window in tokens rather than drawing nothing", () => {
    const unpriced = insightBreakdowns(
      {
        ...summary,
        byHarness: [
          { costUsd: 0, harness: "codex", runs: 2, tokens: 3000 },
          { costUsd: 0, harness: "claude-code", runs: 1, tokens: 1000 },
        ],
      },
      WEB_INSIGHT_WORDS
    ).harness;
    expect(unpriced.unit).toBe("of tokens");
    expect(unpriced.meta).toBe("sorted by tokens");
    expect(unpriced.rows.map((r) => r.weight)).toStrictEqual([3000, 1000]);
  });
});

/*
 * The page either SAYS a field or WITHHOLDS it on the record (#775). A field
 * that is neither is a silent deletion: the gateway keeps computing it, the
 * page stops drawing it, and every other test stays green.
 *
 * The fixture is typed `InsightsSummary`, so a new gateway field fails
 * typecheck here first. Dropping a rendered field on purpose means moving it
 * into WITHHELD with its reason — a reviewable line, not an absence.
 */

/** Everything a reader can actually get off the page: its words, plus the
 *  per-column figures a pointer reads from each column's own `title`. */
function readable(el: HTMLElement): string {
  return [
    el.textContent ?? "",
    ...[...el.querySelectorAll("[title]")].map(
      (node) => node.getAttribute("title") ?? ""
    ),
  ].join(" ¶ ");
}

/** Gives the two fields the shared fixture zeroes a value to show. */
const withUnreported: InsightsSummary = {
  ...summary,
  kpis: { ...summary.kpis, unpricedRuns: 0, unreportedRuns: 4 },
};

/** field → the exact string it puts on the page, and the rollup that shows it. */
const RENDERS: Readonly<
  Record<string, { shows: string; from?: InsightsSummary }>
> = {
  attention: { shows: "Daily Digest · 59% of spend" },
  byEffort: { shows: "$0.80 · 7k · 4 runs" },
  byHarness: { shows: "$2.50 · 11k · 7 runs" },
  byModel: { shows: "claude-opus-4-8" },
  bySource: { shows: "$2.00 · 8k · 6 runs" },
  daily: { shows: "10 Jun · $0.20 · 3 runs" },
  // The rollup's own clock is what the axis is dated against — a summary read
  // an hour later still names the same oldest day.
  generatedAt: { shows: "12 May" },
  "kpis.estimatedCostUsd": { shows: "$1.30 estimated" },
  "kpis.failedCostUsd": { shows: "2 · $0.40 spent" },
  "kpis.failedRuns": { shows: "42 runs · 2 failed" },
  "kpis.forecastCostUsd": { shows: "$5.10" },
  "kpis.generations": { shows: "42 · 3 retried" },
  "kpis.harnessReportedCostUsd": { shows: "$2.10 harness-reported" },
  "kpis.hydrationTokens": { shows: "128k · 1k hydration" },
  "kpis.retries": { shows: "· 3 retried" },
  "kpis.totalCostUsd": { shows: "$3.40" },
  "kpis.totalTokens": { shows: "128k" },
  "kpis.unpricedRuns": { shows: "1 unpriced." },
  "kpis.unreportedRuns": {
    from: withUnreported,
    shows: "4 no usage reported.",
  },
  peakDay: { shows: "Busiest 9 Jun: $0.40" },
  recent: { shows: "A failed run" },
};

/** field → why the page does not say it. Not a backlog: each line is a stated
 *  product decision, and moving a field in here is a reviewed edit. */
const WITHHELD: Readonly<Record<string, string>> = {
  "kpis.appsTouched":
    "the rollup counts it, but 'how many apps did work touch' is a different question from 'what did this cost' — the page has one subject and does not borrow this one.",
  windowDays:
    "the window is the shell's own state, passed as the `windowDays` prop; the copy inside the rollup is the window the GATEWAY answered for and would silently disagree with the picker after a change.",
};

/** Every field of the rollup, `kpis` expanded key by key — a container is not a
 *  leaf, so a newly served KPI must answer for itself. */
function rollupFields(rollup: InsightsSummary): string[] {
  return [
    ...Object.keys(rollup).filter((key) => key !== "kpis"),
    ...Object.keys(rollup.kpis).map((key) => `kpis.${key}`),
  ].sort();
}

describe("screens/InsightsScreen — the gateway's rollup, field by field (#775)", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  test("[law:insights-rollup-render-or-withhold] every field of the gateway's rollup is on the page or withheld on the record", () => {
    expect(rollupFields(summary)).toStrictEqual(
      [...Object.keys(RENDERS), ...Object.keys(WITHHELD)].sort()
    );

    const byRollup = new Map<InsightsSummary, string[]>();
    for (const [field, { from }] of Object.entries(RENDERS)) {
      const rollup = from ?? summary;
      byRollup.set(rollup, [...(byRollup.get(rollup) ?? []), field]);
    }

    const unsaid: string[] = [];
    for (const [rollup, fields] of byRollup) {
      const words = readable(screen({ summary: rollup }));
      unsaid.push(
        ...fields.filter(
          (field) => !words.includes(RENDERS[field]?.shows ?? "")
        )
      );
      act(() => root?.unmount());
      root = null;
      container?.remove();
      container = null;
    }
    expect(unsaid).toStrictEqual([]);
  });
});
