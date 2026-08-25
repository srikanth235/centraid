// What Analytics SAYS about the run rollup (#775) — the words, not the frame.
//
// Pure: no React and no gateway, so the copy contract is under test without
// mounting anything. The screen owns the column of blocks; every string in it
// is decided here.
//
// TWO HONEST GAPS, unchanged and stated where they bite rather than papered
// over:
//   1. The daily rollup (`insights-sql.ts`, `daily`) does NOT split a day by
//      outcome, so the chart's columns carry one segment and no legend. The
//      window's failure count is stated once, in the Runs count line.
//   2. No run duration is recorded anywhere, so a "median duration" fact cannot
//      be served and is absent rather than estimated.

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

import { INSIGHTS_FORECAST_NOTE } from "../../insights-copy.js";
import { insK, insUsd, relativeTime } from "../format.js";
import type { InsightsSummary } from "../screen-contracts.js";
import type { BarDatum } from "../ui/BarsBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import { processUsageRows, subsystemUsageRows } from "./resource-summary.js";
import type { ResourceUsageDTO } from "./resource-summary.js";

export type Breakdown = InsightBreakdown;

/** The three windows. The page's one parameter, and its whole state. */
export const WINDOW_OPTIONS = [7, 30, 90] as const;

/**
 * Columns the chart draws: ONE PER DAY (#775).
 *
 * Folding a window into 7–14 columns is how a single $40 afternoon becomes a
 * smear across four ordinary days — the one shape a spend chart exists to
 * show, averaged away. The compact form factor is the only place that folds at
 * all, and it says so in every column's own label.
 */
export function columnCount(windowDays: number, compact: boolean): number {
  return compact ? Math.min(windowDays, 10) : windowDays;
}

function runWord(runs: number): string {
  return `${runs.toLocaleString()} ${runs === 1 ? "run" : "runs"}`;
}

/**
 * The chart's columns: SPEND per day, scaled against the window's own peak.
 *
 * Spend and not runs, because "how much did this cost" is the question the page
 * is answering and a run count answers a different one — twenty cheap chats and
 * one long build are the same column by volume and nothing like it by money.
 * The run count stays in each column's own sentence.
 */
export function buildBars(
  summary: InsightsSummary,
  windowDays: number,
  compact: boolean
): BarDatum[] {
  const buckets = dayFold(summary.daily, {
    // The rollup's own clock, not the reader's: a summary rendered an hour
    // later must still say the same thing about the same days.
    anchor: summary.generatedAt > 0 ? summary.generatedAt : Date.now(),
    columns: columnCount(windowDays, compact),
    windowDays,
  });
  const shares = barShares(buckets.map((bucket) => bucket.costUsd));
  return buckets.map((bucket, index) => {
    const span =
      bucket.date === bucket.endDate
        ? dayMark(bucket.date)
        : `${dayMark(bucket.date)} – ${dayMark(bucket.endDate)}`;
    return {
      id: bucket.key,
      label: `${span} · ${insUsd(bucket.costUsd)} · ${runWord(bucket.runs)}`,
      ok: shares[index] ?? 0,
    };
  });
}

/**
 * The axis marks: real dates, oldest → newest.
 *
 * "30 days ago · halfway · today" told a reader nothing they could check a
 * spike against — a column is a day, and a day has a name.
 */
export function axisMarks(
  summary: InsightsSummary,
  windowDays: number
): string[] {
  const bars = dayFold(summary.daily, {
    anchor: summary.generatedAt > 0 ? summary.generatedAt : Date.now(),
    columns: windowDays,
    windowDays,
  });
  const first = bars[0];
  const middle = bars[Math.floor(bars.length / 2)];
  const last = bars.at(-1);
  if (!first || !last) return [];
  const marks = [dayMark(first.date)];
  if (middle && bars.length > 2) marks.push(dayMark(middle.date));
  marks.push("today");
  return marks;
}

/**
 * The peak day, in words — the only place a column's actual value is stated,
 * because the plot has no value axis. `undefined` when the rollup found no
 * peak (a window where nothing ran).
 */
export function peakNote(summary: InsightsSummary): string | undefined {
  const peak = summary.peakDay;
  if (!peak) return undefined;
  const top = peak.topSources[0];
  return [
    `Busiest ${dayMark(peak.date)}: ${insUsd(peak.costUsd)}`,
    `${insK(peak.tokens)} tokens`,
    ...(top ? [`mostly ${top.label}`] : []),
  ].join(" · ");
}

/** Where the money came from, said plainly. Never "free" for what we could
 *  not price — an unpriced run is unknown, not zero. */
export function pricingLine(summary: InsightsSummary): string {
  const { kpis } = summary;
  const parts: string[] = [];
  if (kpis.harnessReportedCostUsd > 0)
    parts.push(`${insUsd(kpis.harnessReportedCostUsd)} harness-reported`);
  if (kpis.estimatedCostUsd > 0)
    parts.push(`${insUsd(kpis.estimatedCostUsd)} estimated`);
  if (kpis.unpricedRuns > 0) parts.push(`${kpis.unpricedRuns} unpriced`);
  if (kpis.unreportedRuns > 0)
    parts.push(`${kpis.unreportedRuns} no usage reported`);
  if (parts.length === 0) {
    return kpis.generations === 0
      ? "No completed runs in this window."
      : "All priced runs included.";
  }
  return `${parts.join(" · ")}.`;
}

/**
 * The one promoted figure: what the window cost.
 *
 * "Did this month cost $2 or $200" is the question a member opens this page
 * with, and it was being answered by a 13px string in the middle of a fact
 * list. "At least" is the honest label while runs are unpriced: the figure is a
 * floor, and a floor that calls itself a total is a lie.
 */
export function spendFigure(
  summary: InsightsSummary,
  windowDays: number
): PanelFigureData {
  const { kpis } = summary;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  return {
    label: `${incomplete ? "At least" : "Spend"} · ${windowDays} days`,
    qualifier: pricingLine(summary),
    value: insUsd(kpis.totalCostUsd),
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
      mono: true,
      value: kpis.retries
        ? `${kpis.generations.toLocaleString()} · ${kpis.retries} retried`
        : kpis.generations.toLocaleString(),
    },
    {
      key: "tokens",
      mono: true,
      value: kpis.hydrationTokens
        ? `${insK(kpis.totalTokens)} · ${insK(kpis.hydrationTokens)} hydration`
        : insK(kpis.totalTokens),
    },
    {
      key: "forecast",
      mono: true,
      note: INSIGHTS_FORECAST_NOTE,
      value: insUsd(kpis.forecastCostUsd),
    },
  ];
  if (kpis.failedRuns > 0) {
    facts.push({
      key: "failed",
      mono: true,
      // The one fact here that is bad news, so the one that takes `net`.
      net: true,
      value: `${kpis.failedRuns} · ${insUsd(kpis.failedCostUsd)} spent`,
    });
  }
  if (summary.attention) {
    facts.push({
      key: "most of it",
      value: `${summary.attention.label} · ${Math.round(summary.attention.share * 100)}% of spend`,
    });
  }
  return facts;
}

/**
 * The coarse read over the per-source breakdown: runs, share of the window, and
 * what they cost. Failures are not attributed per source by the rollup, so they
 * are not claimed here.
 */
export function sourceFacts(summary: InsightsSummary): PanelFact[] {
  return insightSourceRollups(summary.bySource).map((row) => ({
    key: row.bucket,
    mono: true,
    value: `${row.runs} · ${row.sharePercent === null ? "—" : `${row.sharePercent}%`} · ${insUsd(row.costUsd)}`,
  }));
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
    insUsd,
    insK,
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
    insUsd,
    insK,
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
    insUsd,
    insK,
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
    insUsd,
    insK,
    runWord
  );
}

/**
 * The gateway's own measured numbers, with each row's caveat attached to the
 * row it qualifies.
 *
 * Every row is something the gateway actually reports — no disk figure and no
 * shared-compute figure appear, because this gateway serves neither.
 */
export function gatewayFacts(usage: ResourceUsageDTO): PanelFact[] {
  const facts: PanelFact[] = [
    ...processUsageRows(usage),
    ...subsystemUsageRows(usage),
  ].map((row) => ({
    key: row.label.toLowerCase(),
    mono: true,
    ...(row.note ? { note: row.note } : {}),
    value: row.value,
  }));
  if (usage.backgroundTimerFiresLastHour !== null) {
    facts.push({
      key: "wakeups, last hour",
      mono: true,
      value: String(usage.backgroundTimerFiresLastHour),
    });
  }
  return facts;
}

/**
 * The measurement window the gateway's numbers were counted over.
 *
 * Without it every figure on that panel is a number with no denominator: "120s
 * of CPU" is unremarkable over a week and alarming over a minute, and without
 * it the panel makes the reader guess which.
 */
export function gatewaySince(usage: ResourceUsageDTO | undefined): string {
  if (!usage) return "your own machine";
  return `since ${relativeTime(new Date(usage.sinceMs).toISOString())}`;
}
