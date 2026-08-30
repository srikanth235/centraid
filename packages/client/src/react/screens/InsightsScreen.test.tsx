import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, test } from "vitest";

import {
  insightBreakdowns,
  insightPricingLine,
  insightSourceFacts,
} from "@centraid/design/blocks";

import type { InsightsSummary } from "../screen-contracts.js";
import { WEB_INSIGHT_WORDS } from "./insights-model.js";
import InsightsScreen from "./InsightsScreen.js";
import type { ResourceUsageDTO } from "./resource-summary.js";

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

const nothingRan: InsightsSummary = {
  ...summary,
  attention: undefined,
  byEffort: [],
  byHarness: [],
  byModel: [],
  bySource: [],
  daily: [],
  kpis: {
    ...summary.kpis,
    estimatedCostUsd: 0,
    failedRuns: 0,
    generations: 0,
    harnessReportedCostUsd: 0,
    hydrationTokens: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    unpricedRuns: 0,
    unreportedRuns: 0,
  },
  peakDay: undefined,
  recent: [],
};

const usage: ResourceUsageDTO = {
  backgroundTimerFiresLastHour: 12,
  process: {
    cpuSecondsTotal: 120,
    currentRssBytes: 268_435_456,
    peakRssBytes: 402_653_184,
  },
  sinceMs: GENERATED_AT - 3_600_000,
  subsystems: {
    backup: { bytesUploaded: 0, busyMs: 0, drains: 0 },
    harnessRuns: { busyMs: 9000, cpuSeconds: null, runs: 3 },
    replication: { busyMs: 100, bytesReplicated: 1024, passes: 1 },
    sweeps: { busyMs: 50, passes: 2 },
    workerPool: { busyMs: 1000, tasks: 4 },
  },
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

describe("screens/InsightsScreen (v9, #765)", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("offers the three windows as the page's ONE parameter", () => {
    const picked: number[] = [];
    const el = screen({ onWindowDays: (d) => picked.push(d) });
    const chips = [...el.querySelectorAll(".chip")];
    expect(chips.map((c) => c.textContent)).toStrictEqual([
      "7 days",
      "30 days",
      "90 days",
    ]);
    expect(chips[1]?.getAttribute("aria-pressed")).toBe("true");
    act(() => (chips[2] as HTMLButtonElement).click());
    expect(picked).toStrictEqual([90]);
  });

  it("reads the chart as one image that names its window", () => {
    const el = screen();
    const plot = el.querySelector(".plot");
    expect(plot?.getAttribute("role")).toBe("img");
    expect(plot?.getAttribute("aria-label")).toBe(
      "Spend per day over the last 30 days"
    );
    // ONE COLUMN PER DAY (#775) — thirty days, thirty columns, so a single
    // expensive afternoon is its own column rather than a smear over four.
    const columns = [...el.querySelectorAll(".column")];
    expect(columns).toHaveLength(30);
    expect(columns.at(-1)?.getAttribute("title")).toBe(
      "10 Jun · $0.20 · 3 runs"
    );
  });

  it("gives a day's failed spend its own segment, and only that day's", () => {
    const el = screen();
    const columns = [...el.querySelectorAll(".column")];
    // 9 Jun spent $0.40, half of it on two failed runs.
    const failedDay = columns.at(-2);
    expect(failedDay?.querySelector(".fail")).not.toBeNull();
    expect(
      (failedDay as HTMLElement | undefined)?.style.getPropertyValue(
        "--bar-fail"
      )
    ).toBe("50");
    expect(failedDay?.getAttribute("title")).toBe(
      "9 Jun · $0.40 · 5 runs · 2 failed"
    );
    // The quiet day keeps ONE segment: a zero-height fail spends a colour.
    expect(columns.at(-1)?.querySelector(".fail")).toBeNull();
  });

  it("names the failed colour only when a column can draw it", () => {
    expect(
      [...screen().querySelectorAll(".legendFail")].map((n) => n.textContent)
    ).toStrictEqual(["failed"]);
    act(() => root?.unmount());
    root = null;
    container?.remove();
    // A window whose days hold no failure gets no legend at all.
    const quiet = screen({
      summary: {
        ...summary,
        daily: summary.daily.map((point) => ({
          ...point,
          failedCostUsd: 0,
          failedRuns: 0,
        })),
      },
    });
    expect(quiet.querySelector(".legend")).toBeNull();
  });

  it("states a typical run duration, and withholds it when nothing finished", () => {
    const timed = screen({
      summary: { ...summary, kpis: { ...summary.kpis, medianRunMs: 95_000 } },
    });
    expect(
      [...timed.querySelectorAll(".factKey")].map((n) => n.textContent)
    ).toContain("typical run");
    expect(
      [...timed.querySelectorAll(".factValue")].map((n) => n.textContent)
    ).toContain("1m 35s");
    act(() => root?.unmount());
    root = null;
    container?.remove();
    // An old vault that timed nothing shows no row — never "0s".
    const untimed = screen();
    expect(
      [...untimed.querySelectorAll(".factKey")].map((n) => n.textContent)
    ).not.toContain("typical run");
  });

  it("marks the axis with real dates, and names the peak the plot cannot", () => {
    const el = screen();
    const marks = [...el.querySelectorAll(".axisLabel")].map(
      (n) => n.textContent
    );
    expect(marks).toStrictEqual(["12 May", "27 May", "today"]);
    expect(el.querySelector(".note")?.textContent).toBe(
      "Busiest 9 Jun: $0.40 · 4k tokens · mostly Daily Digest"
    );
  });

  it("draws seven columns on the short window", () => {
    const el = screen({
      summary: { ...summary, windowDays: 7 },
      windowDays: 7,
    });
    expect(el.querySelectorAll(".column")).toHaveLength(7);
    expect(el.querySelector(".axisLabel")?.textContent).toBe("4 Jun");
  });

  it("still states the window's failure count in words above the chart", () => {
    // The per-column split is the day's; the meta line remains the only place
    // the WINDOW's total is stated, so the two never have to be read together.
    expect(screen().textContent).toContain("42 runs · 2 failed");
  });

  it("says every section, including the four categorical breakdowns", () => {
    const el = screen();
    const labels = [...el.querySelectorAll(".label")].map((n) => n.textContent);
    expect(labels).toStrictEqual([
      "Daily activity",
      "By source",
      "By harness",
      "By model",
      "By effort",
      "Recent runs",
      "This machine",
    ]);
  });

  it("draws the breakdowns the gateway was already computing", () => {
    const el = screen();
    const lists = [...el.querySelectorAll("dl[aria-label]")].map((n) =>
      n.getAttribute("aria-label")
    );
    expect(lists).toStrictEqual([
      "Spend per source",
      "Spend by harness",
      "Spend by model",
      "Spend by effort",
    ]);
    // Every row states its share in words, not only as a bar width.
    expect(el.textContent).toContain("claude-code");
    expect(el.textContent).toContain("100% of spend");
    expect(el.textContent).toContain("$2.50 · 11k · 7 runs");
  });

  it("promotes the spend to the display rung, with the honesty line under it", () => {
    const el = screen();
    expect(el.querySelector(".figureLabel")?.textContent).toBe(
      "At least · 30 days"
    );
    expect(el.querySelector(".figureValue")?.textContent).toBe("$3.40");
    expect(el.querySelector(".figureQualifier")?.textContent).toBe(
      "$2.10 harness-reported · $1.30 estimated · 1 unpriced."
    );
    // The retries and the cost of the failures are on the wire and now on the
    // page — a page about spend that cannot say what failure cost is missing
    // the number a member would act on.
    expect(el.textContent).toContain("42 · 3 retried");
    expect(el.textContent).toContain("2 · $0.40 spent");
  });

  it("says the source facts in the numeric register", () => {
    const el = screen();
    const facts = [...el.querySelectorAll(".fact")].map((n) => n.textContent);
    expect(facts).toContain("automations6 · 75% · $2.00");
    expect(facts).toContain("the assistant2 · 25% · $0.30");
    expect(el.textContent).toContain("Daily Digest · 59% of spend");
  });

  it("keeps the pricing honesty — an unpriced run is unknown, never free", () => {
    expect(insightPricingLine(summary, WEB_INSIGHT_WORDS)).toBe(
      "$2.10 harness-reported · $1.30 estimated · 1 unpriced."
    );
    const el = screen();
    expect(el.textContent).toContain("Completed runs in this vault only");
  });

  it("tones a failed run net and offers Open only where a run can be opened", () => {
    const opened: string[] = [];
    const el = screen({ onOpenRun: (a, r) => opened.push(`${a}:${r}`) });
    const rows = [...el.querySelectorAll<HTMLElement>(".row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.net).toBeUndefined();
    expect(rows[1]?.dataset.net).toBe("true");
    expect(rows[0]?.textContent).toContain("Succeeded · Chat · claude-code");
    // Only the automation run has a ref to deep-link to.
    const actions = [...el.querySelectorAll(".row button")];
    expect(actions).toHaveLength(1);
    act(() => (actions[0] as HTMLButtonElement).click());
    expect(opened).toStrictEqual(["app/x:r2"]);
  });

  it("gives the gateway's numbers a denominator, and each row its own caveat", () => {
    const el = screen({ resourceUsage: usage });
    // "120s of CPU" is unremarkable over a week and alarming over a minute.
    const heads = [...el.querySelectorAll(".meta")].map((n) => n.textContent);
    expect(heads.some((head) => head?.startsWith("since "))).toBe(true);
    expect(
      [...el.querySelectorAll(".factNote")].map((n) => n.textContent)
    ).toContain("Measured, not limited by Conserve.");
  });

  it("states the gateway's measured numbers, and the note that frames them", () => {
    const el = screen({ resourceUsage: usage });
    const keys = [...el.querySelectorAll(".factKey")].map((n) => n.textContent);
    expect(keys).toContain("cpu time");
    expect(keys).toContain("memory now");
    expect(keys).toContain("harness runs");
    expect(keys).toContain("wakeups, last hour");
    // No disk and no shared-compute row: the gateway serves neither, so the
    // page omits them rather than inventing a number.
    expect(keys).not.toContain("disk");
    expect(keys).not.toContain("compute shared");
    expect(el.textContent).toContain(
      "These are your own machine’s numbers, not a service’s."
    );
  });

  it("says so when the gateway serves no resource numbers at all", () => {
    const el = screen();
    expect(el.textContent).toContain("Not available from this vault host");
  });

  it("is empty without apologising, and keeps the window reachable", () => {
    const el = screen({ summary: nothingRan });
    expect(el.textContent).toContain("Nothing has run yet");
    expect(el.textContent).toContain(
      "Once automations and the assistant start doing work, their volume and outcomes appear here."
    );
    // Empty offers NO action — there is nothing to do here but wait — but the
    // window picker stays, or a member who picked 7 days could not leave it.
    expect(el.querySelectorAll(".empty button")).toHaveLength(0);
    expect(el.querySelectorAll(".chip")).toHaveLength(3);
  });

  it("has no SVG chart, no KPI grid, and no page title of its own", () => {
    const el = screen({ resourceUsage: usage });
    expect(el.querySelector("svg")).toBeNull();
    expect(el.querySelector("h1")).toBeNull();
    expect(el.textContent).not.toContain("Where it went");
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

function readable(el: HTMLElement): string {
  return [
    el.textContent ?? "",
    ...[...el.querySelectorAll("[title]")].map(
      (node) => node.getAttribute("title") ?? ""
    ),
  ].join(" ¶ ");
}

const withUnreported: InsightsSummary = {
  ...summary,
  kpis: { ...summary.kpis, unpricedRuns: 0, unreportedRuns: 4 },
};

const RENDERS: Readonly<
  Record<string, { shows: string; from?: InsightsSummary }>
> = {
  attention: { shows: "Daily Digest · 59% of spend" },
  byEffort: { shows: "$0.80 · 7k · 4 runs" },
  byHarness: { shows: "$2.50 · 11k · 7 runs" },
  byModel: { shows: "claude-opus-4-8" },
  bySource: { shows: "$2.00 · 8k · 6 runs" },
  daily: { shows: "10 Jun · $0.20 · 3 runs" },
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

const WITHHELD: Readonly<Record<string, string>> = {
  "kpis.appsTouched":
    "the rollup counts it, but 'how many apps did work touch' is a different question from 'what did this cost' — the page has one subject and does not borrow this one.",
  windowDays:
    "the window is the shell's own state, passed as the `windowDays` prop; the copy inside the rollup is the window the GATEWAY answered for and would silently disagree with the picker after a change.",
};

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
