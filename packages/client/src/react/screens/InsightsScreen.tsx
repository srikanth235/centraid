import type { JSX } from "react";

import { insK, insKindLabel, insUsd, relativeTime } from "../format.js";
import type {
  InsightsActivityRow,
  InsightsBridgeProps,
} from "../screen-contracts.js";
import { useCompactLayout } from "../shell/useCompactLayout.js";
import BarsBlock from "../ui/BarsBlock.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import DistributionBlock from "../ui/DistributionBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import {
  axisMarks,
  buildBars,
  effortBreakdown,
  gatewayFacts,
  gatewaySince,
  harnessBreakdown,
  modelBreakdown,
  peakNote,
  sourceBreakdown,
  sourceFacts,
  spendFacts,
  spendFigure,
  WINDOW_OPTIONS,
} from "./insights-model.js";
import type { Breakdown } from "./insights-model.js";

import styles from "./InsightsScreen.module.css";

// Analytics (v9, issues #765 + #775) — one column of blocks over the run
// rollup.
//
// The page has ONE parameter (the window) and no commit: it counts what already
// happened. Its shape is the block vocabulary — a promoted figure, one chart,
// four distributions, a row list, and the gateway's own receipt — and the words
// are all in `insights-model.ts`, which is where the two honest gaps in the
// rollup are stated too.

export { WINDOW_OPTIONS } from "./insights-model.js";

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
            hint: `Open ${run.label}`,
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

/** A breakdown, or nothing at all: an empty distribution is an absence, and a
 *  section head over no rows reads as a failed load. */
function Distribution({
  label,
  breakdown,
  ariaLabel,
}: {
  label: string;
  breakdown: Breakdown;
  ariaLabel: string;
}): JSX.Element | null {
  if (breakdown.rows.length === 0) return null;
  return (
    <>
      <SectionBlock label={label} meta={breakdown.meta} />
      <DistributionBlock
        ariaLabel={ariaLabel}
        rows={breakdown.rows}
        unit={breakdown.unit}
      />
    </>
  );
}

/**
 * Analytics — the run rollup as blocks. The window picker, the spend figure,
 * the daily chart, the four breakdowns, the recent runs, and the gateway's own
 * receipt.
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
  const peak = peakNote(summary);

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

      <PanelBlock
        body="Completed runs in this vault only; estimates use public model rates."
        facts={spendFacts(summary)}
        figure={spendFigure(summary, windowDays)}
      />

      <SectionBlock
        label="Daily activity"
        meta={`${kpis.generations.toLocaleString()} runs${kpis.failedRuns ? ` · ${kpis.failedRuns} failed` : ""}`}
      />
      <BarsBlock
        ariaLabel={`Spend per day over the last ${windowDays} days`}
        axis={axisMarks(summary, windowDays)}
        bars={buildBars(summary, windowDays, compact)}
        {...(compact ? { compact: true } : {})}
        {...(peak ? { note: peak } : {})}
      />

      <Distribution
        ariaLabel="Spend per source"
        breakdown={sourceBreakdown(summary)}
        label="By source"
      />
      {sourceFacts(summary).length > 0 ? (
        <PanelBlock facts={sourceFacts(summary)} />
      ) : null}

      <Distribution
        ariaLabel="Spend by harness"
        breakdown={harnessBreakdown(summary)}
        label="By harness"
      />
      <Distribution
        ariaLabel="Spend by model"
        breakdown={modelBreakdown(summary)}
        label="By model"
      />
      <Distribution
        ariaLabel="Spend by effort"
        breakdown={effortBreakdown(summary)}
        label="By effort"
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

      <SectionBlock label="Gateway" meta={gatewaySince(resourceUsage)} />
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
