// What the Analytics place SAYS about the run rollup (#765, spec §5).
//
// Pure: no React, no gateway, no renderer. The screen owns the frame, the hook
// owns the wire, and every word — the chart's columns, the fact keys, the
// standing sentence, the CSV — is decided here, so the copy contract is under
// test without mounting anything (the split `connectors-model.ts` and
// `kit/components/health-line.ts` already make).
//
// THREE HONEST GAPS, the same three the desktop leg carries, stated here
// rather than papered over:
//
//  1. The daily rollup counts RUNS per day and does NOT split them by outcome
//     (`InsightsDailyPoint` has `runs`, `tokens`, `costUsd` and nothing else),
//     so every column carries ONE segment and the chart has no failed key to
//     legend. The window's failure count is stated once, on the Runs section's
//     own count line, instead of being invented per column.
//  2. No run duration is recorded anywhere in the ledger, so the reference's
//     `median duration · p95` fact cannot be served and is dropped rather than
//     estimated. Spend takes that slot — the fact this page can prove.
//  3. The gateway reports memory, outbox depth, loop lag, fsync and uptime; it
//     reports no disk figure and no shared-compute roster. The reference's
//     `disk` and `compute shared` facts are therefore absent, not zeroed.

import {
  barShares,
  dayFold,
  dayMark,
  insightBreakdown,
  insightSourceRollups,
} from "@centraid/design/blocks";
import type {
  InsightBreakdown,
  PanelFigureData,
} from "@centraid/design/blocks";

import type { BarDatum } from "../../kit/components/bars-model";
import type { HealthCopy } from "../../kit/components/health-line";
import type { PanelFact } from "../../kit/components/PanelBlock";
import {
  formatBytes,
  formatCount,
  formatMs,
  formatUptime,
  formatUsd,
  relativeTime,
} from "../../lib/insights";
import type {
  GatewayHealth,
  InsightsActivityRow,
  InsightsSummary,
} from "../../lib/insights";

export type Breakdown = InsightBreakdown;

/** The three windows. This page's one parameter, and its whole state. */
export const WINDOW_OPTIONS = [7, 30, 90] as const;

/** The window the page opens on before a stored preference lands. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Is this a window this page can actually be in? Guards the stored pref, so
 *  a value written by a future surface cannot put the page in a state its own
 *  chips cannot get it out of. */
export function isWindowDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

/** The window picker, in the reference's order, with the live one marked. */
export function windowChips(
  windowDays: number
): { id: string; label: string; on: boolean }[] {
  return WINDOW_OPTIONS.map((days) => ({
    id: String(days),
    label: `${String(days)} days`,
    on: days === windowDays,
  }));
}

function runWord(runs: number): string {
  return `${runs.toLocaleString()} ${runs === 1 ? "run" : "runs"}`;
}

/**
 * Columns the chart draws: ONE PER DAY, up to what the plot can carry (#775).
 *
 * The chart used to sample every window to ten columns, so a single expensive
 * afternoon was averaged across three ordinary days — the one shape a spend
 * chart exists to show. Every window up to a month is now one column per day;
 * a ninety-day window folds to `max`, and each column says the span it covers.
 */
export function columnCount(windowDays: number, max: number): number {
  return Math.max(1, Math.min(windowDays, max));
}

/**
 * The chart's columns: SPEND per day, scaled against the window's own peak.
 *
 * Spend and not runs, because "what did this cost" is the question the page is
 * answering — twenty cheap chats and one long build are the same column by
 * volume and nothing like it by money. The run count stays in each column's own
 * sentence, which is what a screen reader hears.
 *
 * The fold itself (calendar offset from the window's first day, so a quiet week
 * cannot slide the busy days left) is the shared headless model's, not this
 * screen's. `now` is used only when the rollup did not stamp itself.
 */
export function buildBars(
  summary: InsightsSummary,
  windowDays: number,
  now: number,
  columns: number
): BarDatum[] {
  const buckets = dayFold(summary.daily, {
    anchor: summary.generatedAt > 0 ? summary.generatedAt : now,
    columns,
    windowDays,
  });
  const shares = barShares(buckets.map((bucket) => bucket.costUsd));
  return buckets.map((bucket, index) => {
    const span =
      bucket.date === bucket.endDate
        ? dayMark(bucket.date)
        : `${dayMark(bucket.date)} – ${dayMark(bucket.endDate)}`;
    return {
      // One segment, always: there is no per-day outcome split to stack (gap
      // 1 in the file header).
      failed: 0,
      key: bucket.key,
      label: `${span} · ${formatUsd(bucket.costUsd)} · ${runWord(bucket.runs)}`,
      succeeded: shares[index] ?? 0,
    };
  });
}

/**
 * The axis marks: real dates, oldest → newest.
 *
 * "30 days ago · halfway · today" told a reader nothing they could check a
 * spike against — a column is a day, and a day has a name.
 */
export function axisLabels(
  summary: InsightsSummary,
  windowDays: number,
  now: number
): string[] {
  const days = dayFold([], {
    anchor: summary.generatedAt > 0 ? summary.generatedAt : now,
    columns: windowDays,
    windowDays,
  });
  const first = days[0];
  const middle = days[Math.floor(days.length / 2)];
  if (!first) return [];
  const marks = [dayMark(first.date)];
  if (middle && days.length > 2) marks.push(dayMark(middle.date));
  marks.push("today");
  return marks;
}

/**
 * The peak day, in words — the only place a column's actual value is stated,
 * because the plot has no value axis. Absent when the rollup found no peak.
 */
export function peakNote(summary: InsightsSummary): string | undefined {
  const peak = summary.peakDay;
  if (!peak) return undefined;
  const top = peak.topSources[0];
  return [
    `Busiest ${dayMark(peak.date)}: ${formatUsd(peak.costUsd)}`,
    `${formatCount(peak.tokens)} tokens`,
    ...(top ? [`mostly ${top.label}`] : []),
  ].join(" · ");
}

/** `1,284 runs · 9 failed` — the Runs section's count line, and the only place
 *  the window's failure count is stated (see gap 1). */
export function runsMeta(summary: InsightsSummary): string {
  const { failedRuns, generations } = summary.kpis;
  const runs = `${generations.toLocaleString()} runs`;
  return failedRuns > 0 ? `${runs} · ${String(failedRuns)} failed` : runs;
}

/** `1,284 runs` — the By-source section's count line. */
export function sourceMeta(summary: InsightsSummary): string {
  return `${summary.kpis.generations.toLocaleString()} runs`;
}

/**
 * By-source facts: runs, share of the window, and what they cost.
 *
 * Failures are NOT attributed per source by the rollup, so they are not
 * claimed here — the reference's `6 failed` tail on each bucket has nothing
 * behind it.
 */
export function sourceFacts(summary: InsightsSummary): PanelFact[] {
  return insightSourceRollups(summary.bySource).map((row) => ({
    key: row.bucket,
    value: `${String(row.runs)} · ${row.sharePercent === null ? "—" : `${String(row.sharePercent)}%`} · ${formatUsd(row.costUsd)}`,
  }));
}

/**
 * The one promoted figure: what the window cost.
 *
 * "Did this month cost $2 or $200" is the question a member opens this page
 * with, and it was being answered by a 13pt string in the middle of a fact
 * list. "At least" is the honest label while runs are unpriced — the figure is
 * a floor, and a floor that calls itself a total is a lie.
 */
export function spendFigure(
  summary: InsightsSummary,
  windowDays: number
): PanelFigureData {
  const { kpis } = summary;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  return {
    label: `${incomplete ? "At least" : "Spend"} · ${String(windowDays)} days`,
    qualifier: pricingLine(summary),
    value: formatUsd(kpis.totalCostUsd),
  };
}

/**
 * The facts beside the figure — volume, forecast, and what the failures cost.
 *
 * `retries` and `failedCostUsd` are on the wire and were rendered nowhere: a
 * page about spend that cannot say what was spent on work that failed is
 * missing the number a member would act on.
 */
export function spendFacts(summary: InsightsSummary): PanelFact[] {
  const { kpis } = summary;
  const facts: PanelFact[] = [
    {
      key: "runs",
      value:
        kpis.retries > 0
          ? `${kpis.generations.toLocaleString()} · ${String(kpis.retries)} retried`
          : kpis.generations.toLocaleString(),
    },
    {
      key: "tokens",
      value:
        kpis.hydrationTokens > 0
          ? `${formatCount(kpis.totalTokens)} · ${formatCount(kpis.hydrationTokens)} hydration`
          : formatCount(kpis.totalTokens),
    },
    {
      key: "forecast",
      note: "A 30-day run rate at this window's pace, not a bill.",
      value: formatUsd(kpis.forecastCostUsd),
    },
  ];
  if (kpis.failedRuns > 0)
    facts.push({
      key: "failed",
      // The one fact here that is bad news, so the one that takes `net`.
      net: true,
      value: `${String(kpis.failedRuns)} · ${formatUsd(kpis.failedCostUsd)} spent`,
    });
  if (summary.attention)
    facts.push({
      key: "most of it",
      value: `${summary.attention.label} · ${String(Math.round(summary.attention.share * 100))}% of spend`,
    });
  return facts;
}

/** Spend by harness — which runner the money went to. */
export function harnessBreakdown(summary: InsightsSummary): Breakdown {
  return insightBreakdown(
    summary.byHarness.map((row) => ({
      costUsd: row.costUsd,
      id: row.harness,
      label: row.harness,
      runs: row.runs,
      tokens: row.tokens,
    })),
    formatUsd,
    formatCount,
    runWord
  );
}

/** Spend by model — the one breakdown a member can act on by switching. */
export function modelBreakdown(summary: InsightsSummary): Breakdown {
  return insightBreakdown(
    summary.byModel.map((row) => ({
      costUsd: row.costUsd,
      id: row.model,
      label: row.model,
      runs: row.runs,
      tokens: row.tokens,
    })),
    formatUsd,
    formatCount,
    runWord
  );
}

/** Spend by effort — the harness-confirmed thought level, and what it cost. */
export function effortBreakdown(summary: InsightsSummary): Breakdown {
  return insightBreakdown(
    summary.byEffort.map((row) => ({
      costUsd: row.costUsd,
      id: row.effort,
      label: row.effort,
      runs: row.runs,
      tokens: row.tokens,
    })),
    formatUsd,
    formatCount,
    runWord
  );
}

/** Spend per source — the automation, chat or app the work came from. */
export function sourceBreakdown(summary: InsightsSummary): Breakdown {
  return insightBreakdown(
    summary.bySource.map((row) => ({
      costUsd: row.costUsd,
      id: `${row.kind}:${row.key}`,
      label: row.label,
      runs: row.runs,
      tokens: row.tokens,
    })),
    formatUsd,
    formatCount,
    runWord
  );
}

/**
 * Where the money came from, said plainly. Never "free" for what could not be
 * priced — an unpriced run is unknown, not zero.
 */
export function pricingLine(summary: InsightsSummary): string {
  const { kpis } = summary;
  const parts: string[] = [];
  if (kpis.harnessReportedCostUsd > 0)
    parts.push(`${formatUsd(kpis.harnessReportedCostUsd)} harness-reported`);
  if (kpis.estimatedCostUsd > 0)
    parts.push(`${formatUsd(kpis.estimatedCostUsd)} estimated`);
  if (kpis.unpricedRuns > 0)
    parts.push(`${String(kpis.unpricedRuns)} unpriced`);
  if (kpis.unreportedRuns > 0)
    parts.push(`${String(kpis.unreportedRuns)} no usage reported`);
  if (parts.length === 0)
    return kpis.generations === 0
      ? "No completed runs in this window."
      : "All priced runs included.";
  return `${parts.join(" · ")}.`;
}

/** `Chat` / `Build` / `Automation` — the run kind, in a word. */
function kindLabel(kind: string): string {
  if (kind === "chat") return "Chat";
  if (kind === "build") return "Build";
  if (kind === "automation") return "Automation";
  return kind;
}

/** One recent run, already worded. The screen binds the handler. */
export interface RecentRunRow {
  key: string;
  title: string;
  sub: string;
  meta: string;
  /** The run failed — its METADATA takes `net`; the run's name does not. */
  net: boolean;
  /** Present when this run belongs to an automation the phone can open. */
  automationRef?: string;
}

/**
 * The recent-runs rows.
 *
 * The verb is offered only for a run that belongs to an automation, because
 * that is the only run this app can open: mobile has no single-run view, and
 * `Automations { automationRef }` lands on that automation's own turn list,
 * which is where the run is. A run from the assistant or an app has nowhere to
 * go here, so it carries no button rather than a dead one.
 */
export function recentRows(summary: InsightsSummary): RecentRunRow[] {
  return summary.recent.map((run) => recentRow(run));
}

function recentRow(run: InsightsActivityRow): RecentRunRow {
  const detail = [
    run.ok ? "Succeeded" : "Failed",
    kindLabel(run.kind),
    run.harness,
    run.effort,
    formatUsd(run.costUsd),
    `${formatCount(run.tokens)} tokens`,
  ].filter((part): part is string => Boolean(part));
  return {
    ...(run.automationRef ? { automationRef: run.automationRef } : {}),
    key: run.runId,
    meta: relativeTime(run.startedAt),
    net: !run.ok,
    sub: detail.join(" · "),
    title: run.label,
  };
}

/**
 * The gateway's own measured numbers.
 *
 * Every fact is something this gateway actually reports. No disk figure and no
 * shared-compute roster appear, because the health snapshot serves neither
 * (gap 3) — the reference's four-fact panel is three-to-six honest facts here.
 */
/**
 * WHICH component is unhealthy, named — or `undefined` when they all are well.
 *
 * "3 of 4 healthy" is bad news with no subject: it tells a member something is
 * wrong and nothing about what, so there is nothing to do with it. The names
 * come from the gateway's own component roster.
 */
export function unhealthyComponents(health: GatewayHealth): string | undefined {
  const bad = health.components.filter((c) => c.status !== "ok");
  if (bad.length === 0) return undefined;
  return bad.map((c) => c.component).join(", ");
}

export function gatewayFacts(health: GatewayHealth): PanelFact[] {
  const { metrics } = health;
  const healthy = health.components.filter((c) => c.status === "ok").length;
  const unwell = unhealthyComponents(health);
  const facts: PanelFact[] = [
    {
      key: "uptime",
      value: formatUptime(metrics.uptimeMs),
    },
    {
      key: "memory",
      value: formatBytes(metrics.rssBytes),
    },
    {
      key: "components",
      // The one fact that can be bad news, so it is the one that may take
      // `net`: a component that is not ok is the gateway telling on itself.
      net: unwell !== undefined,
      // …and bad news names its subject rather than leaving the member to
      // guess which of four things is the broken one.
      ...(unwell ? { note: `Not healthy: ${unwell}.` } : {}),
      value: `${String(healthy)} of ${String(health.components.length)} healthy`,
    },
    {
      key: "outbox",
      value: `${formatCount(metrics.outboxPending)} waiting`,
    },
  ];
  if (metrics.eventLoopLagP99Ms !== undefined)
    facts.push({
      key: "loop lag",
      value: `${formatMs(metrics.eventLoopLagP99Ms)} p99`,
    });
  if (metrics.storageFsyncMs !== undefined)
    facts.push({
      key: "storage fsync",
      value: formatMs(metrics.storageFsyncMs),
    });
  return facts;
}

/** "The gateway has been up for 21 days." — the uptime, said at the coarsest
 *  unit that is still true. */
export function uptimeSentence(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined || !Number.isFinite(uptimeMs) || uptimeMs < 0)
    return "This gateway did not report how long it has been up.";
  const days = Math.floor(uptimeMs / DAY_MS);
  if (days >= 1)
    return `The gateway has been up for ${String(days)} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.max(1, Math.floor(uptimeMs / 3_600_000));
  return `The gateway has been up for ${String(hours)} ${hours === 1 ? "hour" : "hours"}.`;
}

/**
 * The standing line's words: how much of the work succeeded, and how long the
 * machine doing it has been up.
 *
 * No median duration — no run duration is recorded (gap 2), so the reference's
 * second clause is replaced by the one the gateway can prove. No inline verb:
 * this page has nothing to act on, only something to read.
 */
export function insightsHealth(
  summary: InsightsSummary | undefined,
  uptimeMs: number | undefined
): HealthCopy {
  const generic = {
    emptyText: "Nothing to attend to · nothing needs you here right now.",
    errorText:
      "This page could not load · everything else on the gateway is unaffected.",
    loadingText: "Reading from the gateway",
  };
  // Nothing read yet, or nothing read successfully: the three generic
  // sentences are the whole copy, and `healthLineFor` picks the one that
  // matches the state.
  if (!summary) return { ...generic, detail: "", label: "" };
  const { failedRuns, generations } = summary.kpis;
  const succeeded = Math.max(0, generations - failedRuns);
  const pct =
    generations === 0 ? 100 : Math.round((succeeded / generations) * 100);
  return {
    ...generic,
    detail: uptimeSentence(uptimeMs),
    label: `${String(pct)}% of runs succeeded`,
  };
}

/** Origin Activity has no machine-health clause; its standing line describes
 * only the run rollup presented on this screen. */
export function originActivityHealth(
  summary: InsightsSummary | undefined
): HealthCopy {
  const generic = {
    emptyText: "Nothing to attend to · nothing needs you here right now.",
    errorText: "Activity could not load · your vault contents are unaffected.",
    loadingText: "Reading vault activity",
  };
  if (!summary) return { ...generic, detail: "", label: "" };
  const { failedRuns, generations } = summary.kpis;
  const succeeded = Math.max(0, generations - failedRuns);
  const pct =
    generations === 0 ? 100 : Math.round((succeeded / generations) * 100);
  return {
    ...generic,
    detail: `${String(generations)} run${generations === 1 ? "" : "s"} in this window.`,
    label: `${String(pct)}% of runs succeeded`,
  };
}

/** Has anything happened at all in this window? The one thing that empties
 *  this page — a window with no runs and no recent tail. */
export function nothingRan(summary: InsightsSummary): boolean {
  return summary.kpis.generations === 0 && summary.recent.length === 0;
}

const CSV_HEADER = "date,runs,tokens,cost_usd";

/** The daily rollup as CSV — the numbers the chart is drawn from, in the order
 *  the chart draws them. */
export function insightsCsv(summary: InsightsSummary): string {
  const rows = summary.daily.map(
    (day) =>
      `${day.date},${String(day.runs)},${String(day.tokens)},${day.costUsd.toFixed(4)}`
  );
  return [CSV_HEADER, ...rows].join("\n");
}

/** `centraid-analytics-30d.csv` — what the share sheet calls the file. */
export function csvFilename(windowDays: number): string {
  return `centraid-analytics-${String(windowDays)}d.csv`;
}
