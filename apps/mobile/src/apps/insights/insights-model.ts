import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";
import {
  INSIGHTS_FORECAST_NOTE,
  INSIGHTS_WINDOW_OPTIONS,
} from "@centraid/client/insights-copy";
import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "@centraid/client/surface-copy";
import { insightColumnCount, insightColumns } from "@centraid/design/blocks";
import type { InsightColumn, InsightWords } from "@centraid/design/blocks";

import type { BarDatum } from "../../kit/components/bars-model";
import type { HealthCopy } from "../../kit/components/health-line";
import type { PanelFact } from "../../kit/components/PanelBlock";
import {
  formatBytes,
  formatCount,
  formatDuration,
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

export const PHONE_INSIGHT_WORDS: InsightWords = {
  cost: formatUsd,
  count: formatCount,
  duration: formatDuration,
  forecastNote: INSIGHTS_FORECAST_NOTE,
};

export function windowChips(
  windowDays: number
): { id: string; label: string; on: boolean }[] {
  return INSIGHTS_WINDOW_OPTIONS.map((days) => ({
    id: String(days),
    label: `${String(days)} days`,
    on: days === windowDays,
  }));
}

export function phoneBars(
  summary: InsightsSummary,
  windowDays: number,
  now: number,
  maxColumns: number
): BarDatum[] {
  return insightColumns(
    summary,
    {
      columns: insightColumnCount(windowDays, maxColumns),
      now,
      windowDays,
    },
    PHONE_INSIGHT_WORDS
  ).map(phoneBar);
}

function phoneBar(column: InsightColumn): BarDatum {
  return {
    failed: column.failed,
    key: column.key,
    label: column.label,
    succeeded: column.share - column.failed,
  };
}

export function failedLegendKey(summary: InsightsSummary): string {
  return summary.daily.some((day) => day.failedRuns > 0) ? "failed" : "";
}

export function runsMeta(summary: InsightsSummary): string {
  const { failedRuns, generations } = summary.kpis;
  const runs = `${generations.toLocaleString()} runs`;
  return failedRuns > 0 ? `${runs} · ${String(failedRuns)} failed` : runs;
}

export function sourceMeta(summary: InsightsSummary): string {
  return `${summary.kpis.generations.toLocaleString()} runs`;
}

function kindLabel(kind: string): string {
  if (kind === "chat") return "Chat";
  if (kind === "build") return "Build";
  if (kind === "automation") return "Automation";
  return kind;
}

export interface RecentRunRow {
  key: string;
  title: string;
  sub: string;
  meta: string;
  net: boolean;
  automationRef?: string;
}

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

export function unhealthyComponents(health: GatewayHealth): string | undefined {
  const bad = health.components.filter((c) => c.status !== "ok");
  if (bad.length === 0) return undefined;
  return bad.map((c) => c.component).join(", ");
}

export function mobileGatewayFacts(health: GatewayHealth): PanelFact[] {
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
      net: unwell !== undefined,
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

export function uptimeSentence(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined || !Number.isFinite(uptimeMs) || uptimeMs < 0)
    return "This gateway did not report how long it has been up.";
  const days = Math.floor(uptimeMs / DAY_MS);
  if (days >= 1)
    return `The gateway has been up for ${String(days)} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.max(1, Math.floor(uptimeMs / 3_600_000));
  return `The gateway has been up for ${String(hours)} ${hours === 1 ? "hour" : "hours"}.`;
}

function succeededPercent(summary: InsightsSummary): number {
  const { failedRuns, generations } = summary.kpis;
  const succeeded = Math.max(0, generations - failedRuns);
  return generations === 0 ? 100 : Math.round((succeeded / generations) * 100);
}

export function insightsHealth(
  summary: InsightsSummary | undefined,
  uptimeMs: number | undefined
): HealthCopy {
  const generic = {
    emptyText: EMPTY_HEALTH,
    errorText: ERROR_HEALTH,
    loadingText: READING_HEALTH,
  };
  if (!summary) return { ...generic, detail: "", label: "" };
  return {
    ...generic,
    detail: uptimeSentence(uptimeMs),
    label: `${String(succeededPercent(summary))}% of runs succeeded`,
  };
}

export function originActivityHealth(
  summary: InsightsSummary | undefined
): HealthCopy {
  const generic = {
    emptyText: EMPTY_HEALTH,
    errorText: "Activity could not load · your vault contents are unaffected.",
    loadingText: "Reading vault activity",
  };
  if (!summary) return { ...generic, detail: "", label: "" };
  const { generations } = summary.kpis;
  return {
    ...generic,
    detail: `${String(generations)} run${generations === 1 ? "" : "s"} in this window.`,
    label: `${String(succeededPercent(summary))}% of runs succeeded`,
  };
}

export function nothingRan(summary: InsightsSummary): boolean {
  return summary.kpis.generations === 0 && summary.recent.length === 0;
}
