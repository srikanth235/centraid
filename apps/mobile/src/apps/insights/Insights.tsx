import React, { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import {
  INSIGHTS_EMPTY_BODY,
  INSIGHTS_EMPTY_TITLE,
  INSIGHTS_ERROR_BODY,
  INSIGHTS_ERROR_TITLE,
  INSIGHTS_SPEND_NOTE,
} from "@centraid/client/insights-copy";
import { RETRY_ACTION, SKELETON_NOTE } from "@centraid/client/surface-copy";
import {
  insightAxisMarks,
  insightBreakdowns,
  insightPeakNote,
  insightSourceFacts,
  insightSpendFacts,
  insightSpendFigure,
} from "@centraid/design/blocks";
import type { InsightBreakdown } from "@centraid/design/blocks";

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
import { memberFacingError } from "../../kit/member-error";
import { ACTIVITY_SECTION_ORDER } from "../../kit/origin-seat-layout";
import { useTheme } from "../../kit/theme";
import type { InsightsScreenProps } from "../../navigation";
import GatewayAlerts from "./GatewayAlerts";
import {
  failedLegendKey,
  originActivityHealth,
  phoneBars,
  PHONE_INSIGHT_WORDS,
  recentRows,
  runsMeta,
  sourceMeta,
  windowChips,
} from "./insights-model";
import { styles } from "./Insights.styles";
import { useInsights } from "./useInsights";
import type { InsightsController } from "./useInsights";

const ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD";
const ERROR_TITLE = INSIGHTS_ERROR_TITLE;
const ERROR_BODY = INSIGHTS_ERROR_BODY;
const ERROR_RETRY = RETRY_ACTION;

const EMPTY_TITLE = INSIGHTS_EMPTY_TITLE;
const EMPTY_BODY = INSIGHTS_EMPTY_BODY;

const LOADING_NOTE = SKELETON_NOTE;

const LEGEND_RUNS = "runs";

function Distribution({
  label,
  breakdown,
  accessibilityLabel,
}: {
  label?: string;
  breakdown: InsightBreakdown;
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
}: {
  page: InsightsController;
  onOpenAutomation: (automationRef: string) => void;
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
                  value: memberFacingError(load.reason),
                },
              ]
            : undefined
        }
        action={{ label: ERROR_RETRY, onPress: page.retry }}
        title={ERROR_TITLE}
        tone="net"
      />
    );

  const { summary } = load;
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
  const peak = insightPeakNote(summary, PHONE_INSIGHT_WORDS);
  const breakdowns = insightBreakdowns(summary, PHONE_INSIGHT_WORDS);
  const sourceFacts = insightSourceFacts(summary, PHONE_INSIGHT_WORDS);
  return (
    <>
      {chips}
      <PanelBlock
        body={INSIGHTS_SPEND_NOTE}
        facts={insightSpendFacts(summary, PHONE_INSIGHT_WORDS)}
        figure={insightSpendFigure(summary, windowDays, PHONE_INSIGHT_WORDS)}
      />

      <SectionBlock
        label={ACTIVITY_SECTION_ORDER[0]}
        meta={runsMeta(summary)}
      />
      <BarsBlock
        accessibilityLabel={`Spend per day over the last ${String(windowDays)} days`}
        axis={insightAxisMarks(summary, windowDays, page.now)}
        data={phoneBars(summary, windowDays, page.now, MAX_COLUMNS)}
        legendFailed={failedLegendKey(summary)}
        legendSucceeded={LEGEND_RUNS}
        {...(peak ? { note: peak } : {})}
      />

      <SectionBlock
        label={ACTIVITY_SECTION_ORDER[1]}
        meta={sourceMeta(summary)}
      />
      <Distribution
        accessibilityLabel="Spend per source"
        breakdown={breakdowns.source}
      />
      {sourceFacts.length > 0 ? <PanelBlock facts={sourceFacts} /> : null}

      <Distribution
        accessibilityLabel="Spend by harness"
        breakdown={breakdowns.harness}
        label={ACTIVITY_SECTION_ORDER[2]}
      />
      <Distribution
        accessibilityLabel="Spend by model"
        breakdown={breakdowns.model}
        label={ACTIVITY_SECTION_ORDER[3]}
      />
      <Distribution
        accessibilityLabel="Spend by effort"
        breakdown={breakdowns.effort}
        label={ACTIVITY_SECTION_ORDER[4]}
      />

      {recent.length > 0 ? (
        <>
          <SectionBlock
            label={ACTIVITY_SECTION_ORDER[5]}
            meta={String(recent.length)}
          />
          <RowsBlock
            accessibilityLabel="Recent runs"
            rows={recent.map((run) => ({
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
  const line = healthLineFor(page.state, originActivityHealth(summary));

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
              title="Activity"
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
              {memberFacingError(page.exportError)}
            </Text>
          ) : null}
          <AnalyticsBody
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
