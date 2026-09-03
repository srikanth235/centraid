import { FlashList } from "@shopify/flash-list";
import type { FlashListRef } from "@shopify/flash-list";
import { Image } from "expo-image";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { pageMargin, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { buildPeriods, periodContaining } from "./timeline-grains";
import type { GrainPeriod, SummaryGrain } from "./timeline-grains";
import type { PhotoSection } from "./timeline-model";
import { GRAIN_CONTROL_SLOT } from "./TimelineGrainControl";

const YEAR_COVER_RATIO = 0.72;
const MONTH_COVER_RATIO = 1;
const CARD_GUTTER = 8;
const CARD_BOTTOM = 20;

type GrainRow =
  | { type: "year-header"; key: string; title: string }
  | { type: "year-card"; key: string; period: GrainPeriod }
  | {
      type: "month-pair";
      key: string;
      left: GrainPeriod;
      right: GrainPeriod | undefined;
    };

function monthRows(periods: readonly GrainPeriod[]): GrainRow[] {
  const years = new Set(periods.map((period) => period.year));
  const rows: GrainRow[] = [];
  let currentYear: string | undefined;
  let pending: GrainPeriod | undefined;
  const flush = (): void => {
    if (!pending) return;
    rows.push({
      key: pending.key,
      left: pending,
      right: undefined,
      type: "month-pair",
    });
    pending = undefined;
  };
  for (const period of periods) {
    if (period.year !== currentYear) {
      flush();
      currentYear = period.year;
      if (years.size > 1)
        rows.push({
          key: `y:${period.year}`,
          title: period.year,
          type: "year-header",
        });
    }
    if (pending) {
      rows.push({
        key: pending.key,
        left: pending,
        right: period,
        type: "month-pair",
      });
      pending = undefined;
    } else pending = period;
  }
  flush();
  return rows;
}

function rowIndexOfPeriod(rows: readonly GrainRow[], key: string): number {
  return rows.findIndex(
    (row) =>
      (row.type === "year-card" && row.period.key === key) ||
      (row.type === "month-pair" &&
        (row.left.key === key || row.right?.key === key))
  );
}

export interface PhotoGrainViewProps {
  sections: PhotoSection[];
  grain: SummaryGrain;
  onOpenPeriod: (period: GrainPeriod) => void;
  focusDay?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export default function PhotoGrainView({
  sections,
  grain,
  onOpenPeriod,
  focusDay,
  refreshing = false,
  onRefresh,
}: PhotoGrainViewProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const list = useRef<FlashListRef<GrainRow>>(null);

  const periods = useMemo(
    () => buildPeriods(sections, grain),
    [grain, sections]
  );
  const rows = useMemo(
    (): GrainRow[] =>
      grain === "years"
        ? periods.map((period) => ({
            key: period.key,
            period,
            type: "year-card",
          }))
        : monthRows(periods),
    [grain, periods]
  );
  const stickyIndices = useMemo(
    () =>
      rows.flatMap((row, index) => (row.type === "year-header" ? [index] : [])),
    [rows]
  );

  const stageWidth = Math.max(1, width - 2 * pageMargin);
  const yearCoverHeight = Math.round(stageWidth * YEAR_COVER_RATIO);
  const monthCardWidth = Math.max(
    1,
    Math.floor((stageWidth - CARD_GUTTER) / 2)
  );
  const monthCoverHeight = Math.round(monthCardWidth * MONTH_COVER_RATIO);

  const landedOn = useRef<string | undefined>(undefined);
  useEffect(() => {
    const target = periodContaining(periods, focusDay);
    if (!target || landedOn.current === target.key) return;
    const index = rowIndexOfPeriod(rows, target.key);
    if (index < 0) return;
    landedOn.current = target.key;
    void list.current?.scrollToIndex({
      animated: false,
      index,
      viewPosition: 0,
    });
  }, [focusDay, periods, rows]);

  const renderCard = useCallback(
    (
      period: GrainPeriod,
      coverHeight: number,
      overlaid: boolean
    ): React.JSX.Element => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${period.title}, ${period.count}`}
        onPress={() => onOpenPeriod(period)}
        style={styles.card}
      >
        <View style={[styles.coverFrame, { height: coverHeight }]}>
          {period.cover ? (
            <Image
              source={imageSource(period.cover.uri)}
              {...gridImageProps(period.cover.uri)}
              recyclingKey={period.cover.id}
              style={styles.cover}
            />
          ) : (
            <View style={styles.coverEmpty} />
          )}
          {overlaid ? (
            <View style={styles.overlay}>
              <View style={styles.scrim} />
              <Text style={styles.overlayTitle} numberOfLines={1}>
                {period.title}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.caption}>
          {overlaid ? null : (
            <Text style={styles.cardTitle} numberOfLines={1}>
              {period.title}
            </Text>
          )}
          <Text style={styles.cardCount} numberOfLines={1}>
            {period.count}
          </Text>
        </View>
      </Pressable>
    ),
    [onOpenPeriod, styles]
  );

  const renderRow = useCallback(
    ({ item }: { item: GrainRow }): React.JSX.Element => {
      if (item.type === "year-header")
        return (
          <View style={styles.yearHeader}>
            <Text style={styles.yearHeaderTitle} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
        );
      if (item.type === "year-card")
        return (
          <View style={styles.page}>
            {renderCard(item.period, yearCoverHeight, true)}
          </View>
        );
      return (
        <View style={[styles.page, styles.pair]}>
          <View style={{ width: monthCardWidth }}>
            {renderCard(item.left, monthCoverHeight, false)}
          </View>
          {/* Odd month leaves its column empty — a wider card would read as a bigger month. */}
          <View style={{ width: monthCardWidth }}>
            {item.right
              ? renderCard(item.right, monthCoverHeight, false)
              : null}
          </View>
        </View>
      );
    },
    [monthCardWidth, monthCoverHeight, renderCard, styles, yearCoverHeight]
  );

  if (rows.length === 0)
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyLine}>
          These photographs carry no capture date, so they are all in All.
        </Text>
      </View>
    );

  return (
    <FlashList
      maintainVisibleContentPosition={NEWEST_FIRST_ANCHORING}
      ref={list}
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      stickyHeaderIndices={stickyIndices}
      renderItem={renderRow}
      refreshing={refreshing}
      onRefresh={onRefresh}
      contentContainerStyle={{ paddingBottom: GRAIN_CONTROL_SLOT }}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: 8,
      paddingTop: 6,
    },
    card: { paddingBottom: CARD_BOTTOM },
    cardCount: { ...t("mono"), color: colors.textSoft, flexShrink: 0 },
    cardTitle: { ...t("smallStrong"), color: colors.text, flexShrink: 1 },
    cover: { height: "100%", width: "100%" },
    coverEmpty: {
      backgroundColor: colors.bgSunken,
      height: "100%",
      width: "100%",
    },
    coverFrame: {
      borderRadius: radii.md,
      overflow: "hidden",
      width: "100%",
    },
    empty: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: pageMargin,
    },
    emptyLine: { ...t("small"), color: colors.textSoft, textAlign: "center" },
    overlay: {
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      justifyContent: "flex-end",
      paddingBottom: 12,
      paddingHorizontal: 14,
      pointerEvents: "none",
      position: "absolute",
    },
    overlayTitle: { ...t("display"), color: colors.textInv },
    page: { paddingHorizontal: pageMargin },
    pair: { flexDirection: "row", gap: CARD_GUTTER },
    scrim: {
      backgroundColor: colors.scrim,
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      position: "absolute",
      top: 0,
    },
    yearHeader: {
      backgroundColor: colors.bg,
      height: 46,
      justifyContent: "flex-end",
      paddingBottom: 6,
      paddingHorizontal: pageMargin,
    },
    yearHeaderTitle: { ...t("eyebrow"), color: colors.text },
  });
