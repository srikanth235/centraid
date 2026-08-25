// Every word the Analytics place says about the run rollup (#765, spec §5).
// Pure — no React, no gateway — so the copy contract is testable unmounted.
//
// THREE HONEST GAPS bound what may be claimed here:
//  1. The daily rollup does not split runs by outcome, so every column is ONE
//     segment and the failure count is stated once, on the Runs count line.
//  2. No run duration is recorded, so `median duration · p95` is dropped, not
//     estimated; spend takes that slot.
//  3. The health snapshot reports no disk figure and no shared-compute roster,
//     so those facts are absent, not zeroed.

import { INSIGHTS_FORECAST_NOTE } from "@centraid/client/insights-copy";
import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";
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

/** This page's one parameter, and its whole state. */
export const WINDOW_OPTIONS = [7, 30, 90] as const;

export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Guards the stored pref: a value written by a future surface must not strand
 *  the page in a state its own chips cannot leave. */
export function isWindowDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (WINDOW_OPTIONS as readonly number[]).includes(value)
  );
}

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

/** ONE COLUMN PER DAY up to `max` (#775): sampling down to ten columns averages
 *  an expensive afternoon away, which is the shape this chart exists to show. */
export function columnCount(windowDays: number, max: number): number {
  return Math.max(1, Math.min(windowDays, max));
}

/**
 * SPEND per day, not runs: twenty cheap chats and one long build are the same
 * column by volume and nothing like it by money. The run count stays in each
 * column's sentence, which is what a screen reader hears. The calendar fold is
 * the shared headless model's; `now` applies only to an unstamped rollup.
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
      // Always one segment: no per-day outcome split exists (gap 1).
      failed: 0,
      key: bucket.key,
      label: `${span} · ${formatUsd(bucket.costUsd)} · ${runWord(bucket.runs)}`,
      succeeded: shares[index] ?? 0,
    };
  });
}

/** Real dates, oldest → newest: a column is a day, and a day has a name, so a
 *  reader can check a spike against something. */
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

/** The only place a column's actual value is stated — the plot has no value
 *  axis. Absent when the rollup found no peak. */
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

/** The only place the window's failure count is stated (gap 1). */
export function runsMeta(summary: InsightsSummary): string {
  const { failedRuns, generations } = summary.kpis;
  const runs = `${generations.toLocaleString()} runs`;
  return failedRuns > 0 ? `${runs} · ${String(failedRuns)} failed` : runs;
}

export function sourceMeta(summary: InsightsSummary): string {
  return `${summary.kpis.generations.toLocaleString()} runs`;
}

/** No per-source failure count: the rollup does not attribute failures, so
 *  claiming one here would have nothing behind it. */
export function sourceFacts(summary: InsightsSummary): PanelFact[] {
  return insightSourceRollups(summary.bySource).map((row) => ({
    key: row.bucket,
    value: `${String(row.runs)} · ${row.sharePercent === null ? "—" : `${String(row.sharePercent)}%`} · ${formatUsd(row.costUsd)}`,
  }));
}

/** "At least" is required while any run is unpriced: the figure is a floor,
 *  and a floor that calls itself a total is a lie. */
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

/** Volume, forecast, and what the failures cost — the last being the number a
 *  member acts on. */
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
      note: INSIGHTS_FORECAST_NOTE,
      value: formatUsd(kpis.forecastCostUsd),
    },
  ];
  if (kpis.failedRuns > 0)
    facts.push({
      key: "failed",
      // The one fact that is bad news, so the one that takes `net`.
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

/** Never "free" for what could not be priced: an unpriced run is unknown. */
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

function kindLabel(kind: string): string {
  if (kind === "chat") return "Chat";
  if (kind === "build") return "Build";
  if (kind === "automation") return "Automation";
  return kind;
}

/** Already worded; the screen binds the handler. */
export interface RecentRunRow {
  key: string;
  title: string;
  sub: string;
  meta: string;
  /** The run failed — its METADATA takes `net`; the run's name does not. */
  net: boolean;
  /** Present only when the phone can open this run's automation. */
  automationRef?: string;
}

/** The verb is offered only for automation-backed runs: mobile has no
 *  single-run view, so anything else would carry a dead button. */
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

/** Names the unhealthy components, or `undefined` when all are well: "3 of 4
 *  healthy" is bad news with no subject, so there is nothing to do with it. */
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
      // The one fact that can be bad news, so the one that may take `net`.
      net: unwell !== undefined,
      // Bad news names its subject rather than leaving the member guessing.
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

/** The coarsest unit that is still true. */
export function uptimeSentence(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined || !Number.isFinite(uptimeMs) || uptimeMs < 0)
    return "This gateway did not report how long it has been up.";
  const days = Math.floor(uptimeMs / DAY_MS);
  if (days >= 1)
    return `The gateway has been up for ${String(days)} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.max(1, Math.floor(uptimeMs / 3_600_000));
  return `The gateway has been up for ${String(hours)} ${hours === 1 ? "hour" : "hours"}.`;
}

/** No median duration (gap 2) and no inline verb: this page has nothing to act
 *  on, only something to read. */
export function insightsHealth(
  summary: InsightsSummary | undefined,
  uptimeMs: number | undefined
): HealthCopy {
  const generic = {
    emptyText: EMPTY_HEALTH,
    errorText: ERROR_HEALTH,
    loadingText: READING_HEALTH,
  };
  // Nothing read: the generic sentences are the whole copy, and
  // `healthLineFor` picks the one matching the state.
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

/** No machine-health clause: this line describes only the run rollup. */
export function originActivityHealth(
  summary: InsightsSummary | undefined
): HealthCopy {
  const generic = {
    emptyText: EMPTY_HEALTH,
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

/** The one thing that empties this page. */
export function nothingRan(summary: InsightsSummary): boolean {
  return summary.kpis.generations === 0 && summary.recent.length === 0;
}

const CSV_HEADER = "date,runs,tokens,cost_usd";

/** The numbers the chart is drawn from, in the order it draws them. */
export function insightsCsv(summary: InsightsSummary): string {
  const rows = summary.daily.map(
    (day) =>
      `${day.date},${String(day.runs)},${String(day.tokens)},${day.costUsd.toFixed(4)}`
  );
  return [CSV_HEADER, ...rows].join("\n");
}

export function csvFilename(windowDays: number): string {
  return `centraid-analytics-${String(windowDays)}d.csv`;
}
