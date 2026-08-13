import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { InsightsSummary } from "../screen-contracts.js";
import InsightsScreen, {
  buildBars,
  pricingLine,
  sourceFacts,
} from "./InsightsScreen.js";
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
    { costUsd: 0.1, date: day(-29), runs: 2, tokens: 1000 },
    { costUsd: 0.4, date: day(-1), runs: 5, tokens: 4000 },
    { costUsd: 0.2, date: day(0), runs: 3, tokens: 2000 },
  ],
  generatedAt: GENERATED_AT,
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
      "Runs per day over the last 30 days"
    );
    // 14 columns at 30 days; every column carries its own sentence.
    const columns = [...el.querySelectorAll(".column")];
    expect(columns).toHaveLength(14);
    expect(columns.at(-1)?.getAttribute("title")).toBe(
      "8 runs · yesterday – today"
    );
  });

  it("draws seven columns on the short window", () => {
    const el = screen({
      summary: { ...summary, windowDays: 7 },
      windowDays: 7,
    });
    expect(el.querySelectorAll(".column")).toHaveLength(7);
    expect(el.querySelector(".axisLabel")?.textContent).toBe("7 days ago");
  });

  it("claims no per-column outcome split the rollup cannot serve", () => {
    const el = screen();
    // No failed segment and no legend: the daily rollup counts runs, not
    // outcomes, so the chart says runs. The failure count lives in the meta.
    expect(el.querySelector(".fail")).toBeNull();
    expect(el.querySelector(".legend")).toBeNull();
    expect(el.textContent).toContain("42 runs · 2 failed");
  });

  it("says every section, and says the source facts in the numeric register", () => {
    const el = screen();
    const labels = [...el.querySelectorAll(".label")].map((n) => n.textContent);
    expect(labels).toStrictEqual([
      "Runs",
      "By source",
      "Recent runs",
      "Gateway",
    ]);
    const facts = [...el.querySelectorAll(".fact")].map((n) => n.textContent);
    expect(facts[0]).toBe("automations6 · 75% · $2.00");
    expect(facts[1]).toBe("the assistant2 · 25% · $0.30");
    expect(el.textContent).toContain("at least $3.40");
    expect(el.textContent).toContain("Daily Digest · 59% of spend");
  });

  it("keeps the pricing honesty — an unpriced run is unknown, never free", () => {
    expect(pricingLine(summary)).toBe(
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
      "The gateway is your own machine. These are its numbers, not a service’s."
    );
  });

  it("says so when the gateway serves no resource numbers at all", () => {
    const el = screen();
    expect(el.textContent).toContain("Not available from this gateway");
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
});

describe("screens/InsightsScreen — folding the rollup into columns", () => {
  it("folds by calendar offset, so a quiet week does not slide the busy days", () => {
    const bars = buildBars(summary, 30, false);
    expect(bars).toHaveLength(14);
    // day(-29) is the window's first day; day(-1)/day(0) are its last.
    expect(bars[0]?.ok).toBeGreaterThan(0);
    expect(bars[1]?.ok).toBe(0);
    expect(bars.at(-1)?.label).toBe("8 runs · yesterday – today");
  });

  it("scales the columns against the window's own peak", () => {
    const bars = buildBars(summary, 30, false);
    expect(Math.max(...bars.map((b) => b.ok))).toBe(100);
    expect(bars.every((b) => b.ok >= 0 && b.ok <= 100)).toBe(true);
  });

  it("samples to ten columns on the compact form factor", () => {
    expect(buildBars(summary, 90, true)).toHaveLength(10);
  });

  it("omits a source with no runs rather than reporting a zero", () => {
    const facts = sourceFacts({ ...summary, bySource: [] });
    expect(facts.map((f) => f.key)).not.toContain("automations");
    expect(facts.map((f) => f.key)).toContain("spend");
  });
});
