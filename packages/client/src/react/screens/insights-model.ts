// What Analytics SAYS about the run rollup (#775) — the words, not the frame.
// TWO HONEST GAPS: the daily rollup does not split a day by outcome, so the
// columns carry one segment and no legend; and no run duration is recorded,
// so a median-duration fact is absent rather than estimated.

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

export const WINDOW_OPTIONS = [7, 30, 90] as const;

/** ONE PER DAY (#775): folding smears a $40 afternoon across four ordinary
 *  days. Only the compact form folds, and it labels every column. */
export function columnCount(windowDays: number, compact: boolean): number {
  return compact ? Math.min(windowDays, 10) : windowDays;
}

function runWord(runs: number): string {
  return `${runs.toLocaleString()} ${runs === 1 ? "run" : "runs"}`;
}

/** SPEND per day, not runs — volume and money are different columns. */
export function buildBars(
  summary: InsightsSummary,
  windowDays: number,
  compact: boolean
): BarDatum[] {
  const buckets = dayFold(summary.daily, {
    // The rollup's own clock: an hour later it must say the same thing.
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

/** Never "free" for what we could not price — unpriced is unknown, not zero. */
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

/** "At least" while runs are unpriced: a floor calling itself a total lies. */
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
      // The only bad news here, so the only `net`.
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

/** Failures are not attributed per source, so none are claimed. */
export function sourceFacts(summary: InsightsSummary): PanelFact[] {
  return insightSourceRollups(summary.bySource).map((row) => ({
    key: row.bucket,
    mono: true,
    value: `${row.runs} · ${row.sharePercent === null ? "—" : `${row.sharePercent}%`} · ${insUsd(row.costUsd)}`,
  }));
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
    insUsd,
    insK,
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
    insUsd,
    insK,
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
    insUsd,
    insK,
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
    insUsd,
    insK,
    runWord
  );
}

/** Only what the gateway actually reports — no disk, no shared compute. */
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

/** "120s of CPU" is unremarkable over a week and alarming over a minute. */
export function gatewaySince(usage: ResourceUsageDTO | undefined): string {
  if (!usage) return "your own machine";
  return `since ${relativeTime(new Date(usage.sinceMs).toISOString())}`;
}
