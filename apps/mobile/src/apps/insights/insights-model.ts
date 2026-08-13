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

function dayLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${String(daysAgo)} days ago`;
}

/**
 * Fold the daily rollup into the chart's ten columns.
 *
 * Days with no runs are ABSENT from `daily` (the rollup groups by day), so the
 * fold is by calendar offset from the window's first day, never by position in
 * the array — otherwise a quiet week would slide the busy days left and the
 * chart would claim work happened on days nothing ran.
 *
 * `now` is the clock the read landed at, used only when the rollup did not
 * stamp itself: a summary rendered an hour later must still say the same thing
 * about the same days.
 *
 * `columns` is the chart's own count, passed in rather than imported: it lives
 * in the block's stylesheet (`BarsBlock.styles`), which pulls the renderer in,
 * and this module stays free of it so the fold is testable on its own.
 */
export function buildBars(
  summary: InsightsSummary,
  windowDays: number,
  now: number,
  columns: number
): BarDatum[] {
  const n = Math.max(1, columns);
  const anchor = summary.generatedAt > 0 ? summary.generatedAt : now;
  const firstDay = Math.floor(anchor / DAY_MS) - (windowDays - 1);
  const runs = Array.from({ length: n }, () => 0);
  for (const point of summary.daily) {
    const ms = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(ms)) continue;
    const offset = Math.floor(ms / DAY_MS) - firstDay;
    const index = Math.floor((offset * n) / windowDays);
    if (index < 0 || index >= n) continue;
    runs[index] = (runs[index] ?? 0) + point.runs;
  }
  const peak = Math.max(1, ...runs);
  return runs.map((count, index) => {
    const from = Math.round((index * windowDays) / n);
    const to = Math.round(((index + 1) * windowDays) / n) - 1;
    const span =
      from === to
        ? dayLabel(windowDays - 1 - from)
        : `${dayLabel(windowDays - 1 - from)} – ${dayLabel(windowDays - 1 - to)}`;
    return {
      // One segment, always: there is no per-day outcome split to stack (gap
      // 1 in the file header).
      failed: 0,
      key: `col-${String(index)}`,
      label: `${String(count)} ${count === 1 ? "run" : "runs"} · ${span}`,
      succeeded: Math.round((count / peak) * 100),
    };
  });
}

/** The three axis marks, oldest → newest. Re-said whenever the window moves. */
export function axisLabels(windowDays: number): [string, string, string] {
  return [`${String(windowDays)} days ago`, "halfway", "today"];
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

/** The three source buckets this page reports, in the reference's order. */
function sourceBucket(kind: string): "automations" | "the assistant" | "apps" {
  if (kind === "automation") return "automations";
  if (kind === "chat") return "the assistant";
  return "apps";
}

/**
 * By-source facts: runs, share of the window, and what they cost.
 *
 * Failures are NOT attributed per source by the rollup, so they are not
 * claimed here — the reference's `6 failed` tail on each bucket has nothing
 * behind it.
 */
export function sourceFacts(summary: InsightsSummary): PanelFact[] {
  const totals = new Map<string, { runs: number; cost: number }>();
  for (const row of summary.bySource) {
    const bucket = sourceBucket(row.kind);
    const seen = totals.get(bucket) ?? { cost: 0, runs: 0 };
    totals.set(bucket, {
      cost: seen.cost + row.costUsd,
      runs: seen.runs + row.runs,
    });
  }
  const totalRuns = [...totals.values()].reduce((sum, t) => sum + t.runs, 0);
  const facts: PanelFact[] = [];
  for (const bucket of ["automations", "the assistant", "apps"] as const) {
    const bucketTotals = totals.get(bucket);
    // A source with no runs in this window is omitted, not zeroed: a row of
    // zeroes reads as a measurement, and this one is an absence.
    if (!bucketTotals) continue;
    const share = totalRuns
      ? `${String(Math.round((bucketTotals.runs / totalRuns) * 100))}%`
      : "—";
    facts.push({
      key: bucket,
      value: `${String(bucketTotals.runs)} · ${share} · ${formatUsd(bucketTotals.cost)}`,
    });
  }
  const { kpis } = summary;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  facts.push(
    {
      key: "spend",
      // "At least" is the honest verb when runs are unpriced: the figure is a
      // floor, and a floor that calls itself a total is a lie.
      value: `${incomplete ? "at least " : ""}${formatUsd(kpis.totalCostUsd)} · ${formatUsd(kpis.forecastCostUsd)} forecast`,
    },
    {
      key: "tokens",
      value:
        kpis.hydrationTokens > 0
          ? `${formatCount(kpis.totalTokens)} · ${formatCount(kpis.hydrationTokens)} hydration`
          : formatCount(kpis.totalTokens),
    }
  );
  if (summary.attention) {
    facts.push({
      key: "most of it",
      value: `${summary.attention.label} · ${String(Math.round(summary.attention.share * 100))}% of spend`,
    });
  }
  return facts;
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
export function gatewayFacts(health: GatewayHealth): PanelFact[] {
  const { metrics } = health;
  const healthy = health.components.filter((c) => c.status === "ok").length;
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
      net: healthy < health.components.length,
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
