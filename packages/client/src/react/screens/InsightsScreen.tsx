import type { JSX } from "react";

import {
  insightBreakdowns,
  insightPeakNote,
  insightSourceFacts,
  insightSpendFacts,
  insightSpendFigure,
} from "@centraid/design/blocks";
import type { InsightBreakdown } from "@centraid/design/blocks";

import {
  INSIGHTS_EMPTY_BODY,
  INSIGHTS_EMPTY_TITLE,
  INSIGHTS_SPEND_NOTE,
  INSIGHTS_WINDOW_OPTIONS,
} from "../../insights-copy.js";
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
  barLegend,
  webGatewayFacts,
  gatewaySince,
  monoFacts,
  webAxis,
  webBars,
  WEB_INSIGHT_WORDS,
} from "./insights-model.js";

import styles from "./InsightsScreen.module.css";

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

function Distribution({
  label,
  breakdown,
  ariaLabel,
}: {
  label: string;
  breakdown: InsightBreakdown;
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
  const peak = insightPeakNote(summary, WEB_INSIGHT_WORDS);
  const breakdowns = insightBreakdowns(summary, WEB_INSIGHT_WORDS);
  const sourceFacts = monoFacts(insightSourceFacts(summary, WEB_INSIGHT_WORDS));
  const legend = barLegend(summary);

  const chips = (
    <ChipsBlock
      ariaLabel="Time window"
      chips={INSIGHTS_WINDOW_OPTIONS.map((days) => ({
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
          body={INSIGHTS_EMPTY_BODY}
          routine
          title={INSIGHTS_EMPTY_TITLE}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {chips}

      <PanelBlock
        body={INSIGHTS_SPEND_NOTE}
        facts={monoFacts(insightSpendFacts(summary, WEB_INSIGHT_WORDS))}
        figure={insightSpendFigure(summary, windowDays, WEB_INSIGHT_WORDS)}
      />

      <SectionBlock
        label="Daily activity"
        meta={`${kpis.generations.toLocaleString()} runs${kpis.failedRuns ? ` · ${kpis.failedRuns} failed` : ""}`}
      />
      <BarsBlock
        ariaLabel={`Spend per day over the last ${windowDays} days`}
        axis={webAxis(summary, windowDays)}
        bars={webBars(summary, windowDays, compact)}
        {...(compact ? { compact: true } : {})}
        {...(legend ? { legend } : {})}
        {...(peak ? { note: peak } : {})}
      />

      <Distribution
        ariaLabel="Spend per source"
        breakdown={breakdowns.source}
        label="By source"
      />
      {sourceFacts.length > 0 ? <PanelBlock facts={sourceFacts} /> : null}

      <Distribution
        ariaLabel="Spend by harness"
        breakdown={breakdowns.harness}
        label="By harness"
      />
      <Distribution
        ariaLabel="Spend by model"
        breakdown={breakdowns.model}
        label="By model"
      />
      <Distribution
        ariaLabel="Spend by effort"
        breakdown={breakdowns.effort}
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

      <SectionBlock label="This machine" meta={gatewaySince(resourceUsage)} />
      {resourceUsage ? (
        <PanelBlock
          body="What this vault’s host actually used — measured, not the browser or phone you’re reading this on."
          facts={webGatewayFacts(resourceUsage)}
        />
      ) : (
        <PanelBlock body="Not available from this vault host — update it to see." />
      )}
      <NoteBlock>
        Measured proxies only — CPU time, bytes moved, and time spent active.
      </NoteBlock>
      <NoteBlock>
        These are your own machine’s numbers, not a service’s.
      </NoteBlock>
    </div>
  );
}
