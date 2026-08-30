// This seat's number words and row shapes over the shared rollup rules in
// `@centraid/design/blocks` (#775, #883).

import {
  insightAxisMarks,
  insightColumnCount,
  insightColumns,
} from "@centraid/design/blocks";
import type { InsightColumn, InsightWords } from "@centraid/design/blocks";

import { INSIGHTS_FORECAST_NOTE } from "../../insights-copy.js";
import { insDuration, insK, insUsd, relativeTime } from "../format.js";
import type { InsightsSummary } from "../screen-contracts.js";
import type { BarDatum } from "../ui/BarsBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import { processUsageRows, subsystemUsageRows } from "./resource-summary.js";
import type { ResourceUsageDTO } from "./resource-summary.js";

export const WEB_INSIGHT_WORDS: InsightWords = {
  cost: insUsd,
  count: insK,
  duration: insDuration,
  forecastNote: INSIGHTS_FORECAST_NOTE,
};

const COMPACT_COLUMNS = 10;

export function monoFacts(facts: readonly PanelFact[]): PanelFact[] {
  return facts.map((fact) => ({ ...fact, mono: true }));
}

/** Seat-named: the phone's mapper returns a different row type. */
export function webBars(
  summary: InsightsSummary,
  windowDays: number,
  compact: boolean
): BarDatum[] {
  return insightColumns(
    summary,
    {
      columns: insightColumnCount(
        windowDays,
        compact ? COMPACT_COLUMNS : windowDays
      ),
      now: Date.now(),
      windowDays,
    },
    WEB_INSIGHT_WORDS
  ).map(webBar);
}

export function webAxis(
  summary: InsightsSummary,
  windowDays: number
): string[] {
  return insightAxisMarks(summary, windowDays, Date.now());
}

function webBar(column: InsightColumn): BarDatum {
  return {
    id: column.key,
    label: column.label,
    ok: column.share - column.failed,
    ...(column.failed > 0 ? { fail: column.failed } : {}),
  };
}

/** A legend only where the chart draws that colour. */
export function barLegend(
  summary: InsightsSummary
): { ok: string; fail: string } | undefined {
  const anyFailed = summary.daily.some((day) => day.failedRuns > 0);
  return anyFailed ? { fail: "failed", ok: "runs" } : undefined;
}

/** Only what the gateway reports — no disk, no shared compute. */
export function webGatewayFacts(usage: ResourceUsageDTO): PanelFact[] {
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

/** A CPU total means nothing without its window. */
export function gatewaySince(usage: ResourceUsageDTO | undefined): string {
  if (!usage) return "your own machine";
  return `since ${relativeTime(new Date(usage.sinceMs).toISOString())}`;
}
