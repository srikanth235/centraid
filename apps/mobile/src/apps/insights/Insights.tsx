// ANALYTICS — what has run, and what it cost (#765, spec §5).
//
// The page has ONE parameter (the window) and NO commit: it counts what
// already happened, so its bar carries a single quiet verb and nothing filled.
// The old shape — a status hero, a five-tile KPI grid, an SVG area chart with
// a gradient fill, and four meter-bar panels — is gone; what survives is the
// data, re-said in the block vocabulary.
//
// The window chips are shown in EVERY state that has a page (ready and empty),
// unlike every other operational screen's filter row, because the window is
// not a filter over rows — it is the question the page is answering, and a
// member who lands on an empty 7 days has to be able to ask about 90.
//
// THREE GAPS ARE VISIBLE HERE RATHER THAN PAPERED OVER, and they are the same
// three the desktop leg carries (`insights-model.ts` states each one where it
// bites): the daily rollup has no per-day failure split, so the chart's
// columns carry one segment and no failed legend key; no run duration is
// recorded, so the reference's `median duration` fact is absent; and the
// gateway reports no disk figure and no shared-compute roster, so those two
// facts are absent from the Gateway panel.

import React, { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import BarsBlock from "../../kit/components/BarsBlock";
import { MAX_COLUMNS } from "../../kit/components/BarsBlock.styles";
import ChipsBlock from "../../kit/components/ChipsBlock";
import DistributionBlock from "../../kit/components/DistributionBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { healthLineFor } from "../../kit/components/health-line";
import HealthLine from "../../kit/components/HealthLine";
import HomeKey from "../../kit/components/HomeKey";
import { Text } from "../../kit/components/NativeText";
import NoteBlock from "../../kit/components/NoteBlock";
import PanelBlock from "../../kit/components/PanelBlock";
import PlaceHeader from "../../kit/components/PlaceHeader";
import RowsBlock from "../../kit/components/RowsBlock";
import SectionBlock from "../../kit/components/SectionBlock";
import SkeletonRows from "../../kit/components/SkeletonRows";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useTheme } from "../../kit/theme";
import type { InsightsScreenProps } from "../../navigation";
import GatewayAlerts from "./GatewayAlerts";
import {
  axisLabels,
  buildBars,
  columnCount,
  effortBreakdown,
  gatewayFacts,
  harnessBreakdown,
  insightsHealth,
  modelBreakdown,
  peakNote,
  recentRows,
  runsMeta,
  sourceBreakdown,
  sourceFacts,
  sourceMeta,
  spendFacts,
  spendFigure,
  unhealthyComponents,
  windowChips,
} from "./insights-model";
import type { Breakdown } from "./insights-model";
import { styles } from "./Insights.styles";
import { useInsights } from "./useInsights";
import type { InsightsController } from "./useInsights";

/** The error state: what failed, what is safe, one way forward. The rollup
 *  rebuilds on its own schedule and nothing here can trigger it, so the verb
 *  is the honest one — ask again. */
const ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD";
const ERROR_TITLE = "The run log is unavailable";
const ERROR_BODY =
  "Runs are still being recorded. This page reads a rollup that is rebuilt every ten minutes, and the rebuild has not finished.";
const ERROR_RETRY = "Try again";

/** The empty state, in the routine register. No action: nothing on this page
 *  makes work happen, so an empty read has nothing to offer but the reason. */
const EMPTY_TITLE = "Nothing has run yet";
const EMPTY_BODY =
  "Once automations and the assistant start doing work, their volume and outcomes appear here.";

/** Why a skeleton, said once, under the skeleton. */
const LOADING_NOTE =
  "A row knows its shape before its content arrives, so nothing reflows when it does.";

/** The note under the Gateway facts, verbatim. */
const GATEWAY_NOTE =
  "The gateway is your own machine. These are its numbers, not a service's.";

/** The Gateway panel when the health read is the half that failed. */
const NO_HEALTH =
  "Not available from this gateway. Its own numbers are reported by the machine running it, and this one did not answer.";

/** The chart's colour key. The `succeeded` word is the ink actually drawn;
 *  the failed key is EMPTY because the rollup carries no per-day outcome split
 *  (gap 1), so no column can ever show that segment. A legend naming a colour
 *  the chart cannot draw would be the page's one dishonest sentence. */
const LEGEND_RUNS = "runs";
const LEGEND_FAILED = "";

/** A breakdown, or nothing at all: an empty distribution is an absence, and a
 *  section head over no rows reads as a failed load. */
function Distribution({
  label,
  breakdown,
  accessibilityLabel,
}: {
  label?: string;
  breakdown: Breakdown;
  accessibilityLabel: string;
}): React.JSX.Element | null {
  if (breakdown.rows.length === 0) return null;
  return (
    <>
      {label ? <SectionBlock label={label} meta={breakdown.meta} /> : null}
      <DistributionBlock
        accessibilityLabel={accessibilityLabel}
        rows={breakdown.rows}
        unit={breakdown.unit}
      />
    </>
  );
}

export default function InsightsScreen({
  navigation,
  route,
}: InsightsScreenProps): React.JSX.Element {
  return route.params?.initialTab === "alerts" ? (
    <GatewayAlerts onLeave={() => navigation.goBack()} />
  ) : (
    <Analytics navigation={navigation} route={route} />
  );
}

function AnalyticsBody({
  page,
  onOpenAutomation,
  onOpenAlerts,
}: {
  page: InsightsController;
  onOpenAutomation: (automationRef: string) => void;
  onOpenAlerts: () => void;
}): React.JSX.Element {
  const { load, state, windowDays } = page;

  if (state === "loading")
    return (
      <>
        <SkeletonRows accessibilityLabel="Reading the run log" />
        <NoteBlock text={LOADING_NOTE} />
      </>
    );

  if (state === "error" || load.kind !== "ready")
    return (
      <PanelBlock
        body={ERROR_BODY}
        eyebrow={ERROR_EYEBROW}
        facts={
          load.kind === "error"
            ? [
                {
                  key: "what happened",
                  net: true,
                  value: load.reason,
                },
              ]
            : undefined
        }
        action={{ label: ERROR_RETRY, onPress: page.retry }}
        title={ERROR_TITLE}
        tone="net"
      />
    );

  const { health, summary } = load;
  const chips = (
    <ChipsBlock
      accessibilityLabel="Time window"
      chips={windowChips(windowDays).map((chip) => ({
        id: chip.id,
        label: chip.label,
        on: chip.on,
        onPress: () => page.setWindowDays(Number(chip.id)),
      }))}
      mono
    />
  );

  if (state === "empty")
    return (
      <>
        {chips}
        <EmptyBlock body={EMPTY_BODY} routine title={EMPTY_TITLE} />
      </>
    );

  const recent = recentRows(summary);
  const peak = peakNote(summary);
  const unhealthy = health ? unhealthyComponents(health) : undefined;
  return (
    <>
      {chips}
      <PanelBlock
        body="Completed runs in this vault only; estimates use public model rates."
        facts={spendFacts(summary)}
        figure={spendFigure(summary, windowDays)}
      />

      <SectionBlock label="Daily activity" meta={runsMeta(summary)} />
      <BarsBlock
        accessibilityLabel={`Spend per day over the last ${String(windowDays)} days`}
        axis={axisLabels(summary, windowDays, page.now)}
        data={buildBars(
          summary,
          windowDays,
          page.now,
          columnCount(windowDays, MAX_COLUMNS)
        )}
        legendFailed={LEGEND_FAILED}
        legendSucceeded={LEGEND_RUNS}
        {...(peak ? { note: peak } : {})}
      />

      <SectionBlock label="By source" meta={sourceMeta(summary)} />
      <Distribution
        accessibilityLabel="Spend per source"
        breakdown={sourceBreakdown(summary)}
      />
      {sourceFacts(summary).length > 0 ? (
        <PanelBlock facts={sourceFacts(summary)} />
      ) : null}

      <Distribution
        accessibilityLabel="Spend by harness"
        breakdown={harnessBreakdown(summary)}
        label="By harness"
      />
      <Distribution
        accessibilityLabel="Spend by model"
        breakdown={modelBreakdown(summary)}
        label="By model"
      />
      <Distribution
        accessibilityLabel="Spend by effort"
        breakdown={effortBreakdown(summary)}
        label="By effort"
      />

      {recent.length > 0 ? (
        <>
          <SectionBlock label="Recent runs" meta={String(recent.length)} />
          <RowsBlock
            accessibilityLabel="Recent runs"
            rows={recent.map((run) => ({
              // A run with no automation behind it has nowhere to go on this
              // surface, so it carries no verb rather than a dead one.
              ...(run.automationRef
                ? {
                    action: {
                      hint: `Open ${run.title}`,
                      label: "Open",
                      onPress: () => onOpenAutomation(run.automationRef ?? ""),
                    },
                  }
                : {}),
              key: run.key,
              meta: run.meta,
              net: run.net,
              sub: run.sub,
              title: run.title,
            }))}
          />
        </>
      ) : null}

      <SectionBlock label="Gateway" meta="your own machine" />
      {health ? (
        <PanelBlock
          facts={gatewayFacts(health)}
          // Bad news gets a verb. "3 of 4 healthy" told a member something was
          // wrong and gave them nowhere to go with it; the alerts place is
          // where the component's own errors are (#775).
          {...(unhealthy
            ? {
                action: {
                  hint: `Not healthy: ${unhealthy}`,
                  label: "See what’s wrong",
                  onPress: onOpenAlerts,
                },
              }
            : {})}
        />
      ) : (
        <PanelBlock body={NO_HEALTH} />
      )}
      <NoteBlock text={GATEWAY_NOTE} />
    </>
  );
}

function Analytics({ navigation }: InsightsScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const page = useInsights();
  const ink = useMemo(
    () => ({
      error: { color: colors.net },
      safe: { backgroundColor: colors.bg },
    }),
    [colors]
  );
  const summary = page.load.kind === "ready" ? page.load.summary : undefined;
  const health = page.load.kind === "ready" ? page.load.health : undefined;
  const line = healthLineFor(
    page.state,
    insightsHealth(summary, health?.metrics.uptimeMs)
  );

  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink.safe]}>
      <View style={styles.page}>
        <View style={styles.head}>
          <HomeKey onPress={() => navigation.goBack()} variant="leave" />
          <View style={styles.headBar}>
            {/* No filled verb at all — this page writes nothing. The quiet
                verb is withdrawn while loading (the reference's own gating)
                and while there is nothing read to export, because a share
                sheet over an empty file is worse than no button. */}
            <PlaceHeader
              title="Analytics"
              {...(summary && !page.exporting
                ? {
                    secondary: { label: "Export CSV", onPress: page.exportCsv },
                  }
                : {})}
            />
          </View>
        </View>
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl
              onRefresh={() => void page.refresh()}
              refreshing={page.refreshing}
              tintColor={colors.textFaint}
            />
          }
        >
          {page.exportError ? (
            <Text style={[styles.exportError, ink.error]}>
              {page.exportError}
            </Text>
          ) : null}
          <AnalyticsBody
            onOpenAlerts={() =>
              navigation.navigate("Insights", { initialTab: "alerts" })
            }
            onOpenAutomation={(automationRef) =>
              navigation.navigate("Automations", { automationRef })
            }
            page={page}
          />
        </ScrollView>
      </View>
      <HealthLine text={line.text} />
    </TopSafeArea>
  );
}
