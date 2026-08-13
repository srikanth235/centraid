import type { JSX } from "react";

import { insK, insKindLabel, insUsd, relativeTime } from "../format.js";
import type {
  InsightsActivityRow,
  InsightsBridgeProps,
  InsightsSummary,
} from "../screen-contracts.js";
import { useCompactLayout } from "../shell/useCompactLayout.js";
import BarsBlock from "../ui/BarsBlock.js";
import type { BarDatum } from "../ui/BarsBlock.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { processUsageRows, subsystemUsageRows } from "./resource-summary.js";
import type { ResourceUsageDTO } from "./resource-summary.js";

import styles from "./InsightsScreen.module.css";

// Analytics (v9, issue #765) — one column of blocks over the run rollup.
//
// The page has ONE parameter (the window) and no commit: it counts what
// already happened. The old shape — a spend hero, a five-tile KPI strip, an
// SVG area chart with a gradient fill, and five breakdown panels — is gone;
// what survives is the data, re-said in the block vocabulary.
//
// TWO HONEST GAPS, both visible in the code below rather than papered over:
//   1. The rollup (`insights-sql.ts`, `daily`) counts runs per day but does
//      NOT split them by outcome, so the bars carry one segment (runs) and no
//      legend. The window's failure count is stated in the app-bar count line
//      and the section meta instead of being invented per column.
//   2. No run duration is recorded anywhere, so the spec's "median duration"
//      fact cannot be served. Spend takes that slot — the fact this page has
//      always been able to prove.

/** The three windows. The page's one parameter, and its whole state. */
export const WINDOW_OPTIONS = [7, 30, 90] as const;

const DAY_MS = 86_400_000;

/** Columns in the chart: 7 for the short window, 14 otherwise, 10 on a phone
 *  regardless — a sampled view, not one column per day. */
function columnCount(windowDays: number, compact: boolean): number {
  if (compact) return 10;
  return windowDays <= 7 ? 7 : 14;
}

function dayLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo} days ago`;
}

/**
 * Fold the daily rollup into N columns.
 *
 * Days with no runs are absent from `daily` (the rollup groups by day), so the
 * fold is by CALENDAR OFFSET from the window's first day, never by position in
 * the array — otherwise a quiet week would slide the busy days left.
 */
export function buildBars(
  summary: InsightsSummary,
  windowDays: number,
  compact: boolean
): BarDatum[] {
  const n = columnCount(windowDays, compact);
  // The rollup's own clock, not the reader's: a summary rendered an hour later
  // must still say the same thing about the same days.
  const anchor = summary.generatedAt > 0 ? summary.generatedAt : Date.now();
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
      id: `col-${index}`,
      label: `${count} ${count === 1 ? "run" : "runs"} · ${span}`,
      ok: Math.round((count / peak) * 100),
    };
  });
}

/** The three source buckets the page reports, in the spec's order. */
function sourceBucket(kind: string): "automations" | "the assistant" | "apps" {
  if (kind === "automation") return "automations";
  if (kind === "chat") return "the assistant";
  return "apps";
}

/** By-source facts: runs, share of the window, and what they cost. Failures
 *  are not attributed per source by the rollup, so they are not claimed. */
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
    const totalsForBucket = totals.get(bucket);
    // A source with no runs in this window is omitted, not zeroed: a row of
    // zeroes reads as a measurement, and this one is an absence.
    if (!totalsForBucket) continue;
    const share = totalRuns
      ? `${Math.round((totalsForBucket.runs / totalRuns) * 100)}%`
      : "—";
    facts.push({
      key: bucket,
      mono: true,
      value: `${totalsForBucket.runs} · ${share} · ${insUsd(totalsForBucket.cost)}`,
    });
  }
  const { kpis } = summary;
  const incomplete = kpis.unpricedRuns > 0 || kpis.unreportedRuns > 0;
  facts.push(
    {
      key: "spend",
      mono: true,
      // "At least" is the honest verb when runs are unpriced: the figure is a
      // floor, and a floor that calls itself a total is a lie.
      value: `${incomplete ? "at least " : ""}${insUsd(kpis.totalCostUsd)} · ${insUsd(kpis.forecastCostUsd)} forecast`,
    },
    {
      key: "tokens",
      mono: true,
      value: kpis.hydrationTokens
        ? `${insK(kpis.totalTokens)} · ${insK(kpis.hydrationTokens)} hydration`
        : insK(kpis.totalTokens),
    }
  );
  if (summary.attention) {
    facts.push({
      key: "most of it",
      value: `${summary.attention.label} · ${Math.round(summary.attention.share * 100)}% of spend`,
    });
  }
  return facts;
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

function recentRow(
  run: InsightsActivityRow,
  onOpenRun: InsightsBridgeProps["onOpenRun"]
): RowDef {
  const detail = [
    run.ok ? "Succeeded" : "Failed",
    insKindLabel(run.kind),
    run.harness,
    run.effort,
    insUsd(run.costUsd),
    `${insK(run.tokens)} tokens`,
  ].filter((part): part is string => Boolean(part));
  const openable = Boolean(run.automationRef && onOpenRun);
  return {
    id: run.runId,
    ...(openable
      ? {
          action: {
            label: "Open",
            onClick: () => onOpenRun?.(run.automationRef ?? "", run.runId),
          },
        }
      : {}),
    meta: relativeTime(new Date(run.startedAt).toISOString()),
    ...(run.ok ? {} : { net: true }),
    sub: detail.join(" · "),
    title: run.label,
  };
}

/** The gateway's own measured numbers. Every row is something the gateway
 *  actually reports — no disk figure and no shared-compute figure appear,
 *  because this gateway serves neither. */
export function gatewayFacts(usage: ResourceUsageDTO): PanelFact[] {
  const facts: PanelFact[] = [
    ...processUsageRows(usage),
    ...subsystemUsageRows(usage),
  ].map((row) => ({
    key: row.label.toLowerCase(),
    mono: true,
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
 * Analytics — the run rollup as blocks. The window picker, the runs chart,
 * the source facts, the recent runs, and the gateway's own numbers.
 */
export default function InsightsScreen({
  summary,
  windowDays,
  onWindowDays,
  onOpenRun,
  resourceUsage,
}: InsightsBridgeProps): JSX.Element {
  const compact = useCompactLayout();
  const { kpis } = summary;
  const nothingRan = kpis.generations === 0 && summary.recent.length === 0;

  const chips = (
    <ChipsBlock
      ariaLabel="Time window"
      chips={WINDOW_OPTIONS.map((days) => ({
        id: String(days),
        label: `${days} days`,
        on: days === windowDays,
      }))}
      mono
      onPick={(id) => onWindowDays(Number(id))}
    />
  );

  if (nothingRan) {
    return (
      <div className={styles.page}>
        {chips}
        <EmptyBlock
          body="Once automations and the assistant start doing work, their volume and outcomes appear here."
          routine
          title="Nothing has run yet"
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {chips}

      <SectionBlock
        label="Runs"
        meta={`${kpis.generations.toLocaleString()} runs${kpis.failedRuns ? ` · ${kpis.failedRuns} failed` : ""}`}
      />
      <BarsBlock
        ariaLabel={`Runs per day over the last ${windowDays} days`}
        axis={[`${windowDays} days ago`, "halfway", "today"]}
        bars={buildBars(summary, windowDays, compact)}
        {...(compact ? { compact: true } : {})}
      />

      <SectionBlock
        label="By source"
        meta={`${kpis.generations.toLocaleString()} runs`}
      />
      <PanelBlock
        body={`${pricingLine(summary)} Completed runs in this vault only; estimates use public model rates.`}
        facts={sourceFacts(summary)}
      />

      {summary.recent.length > 0 ? (
        <>
          <SectionBlock
            label="Recent runs"
            meta={String(summary.recent.length)}
          />
          <RowsBlock
            rows={summary.recent.map((run) => recentRow(run, onOpenRun))}
          />
        </>
      ) : null}

      <SectionBlock label="Gateway" meta="your own machine" />
      {resourceUsage ? (
        <PanelBlock
          body="What this vault’s gateway host actually used — measured, not the browser or phone you’re reading this on."
          facts={gatewayFacts(resourceUsage)}
        />
      ) : (
        <PanelBlock body="Not available from this gateway. Update the gateway host to see what it actually used." />
      )}
      <NoteBlock>
        Measured proxies only — CPU time, bytes moved, and time spent active.
        Harness runs are measured but not limited by Conserve, and no wattage
        appears because software alone cannot measure power draw.
      </NoteBlock>
      <NoteBlock>
        The gateway is your own machine. These are its numbers, not a service’s.
      </NoteBlock>
    </div>
  );
}
