// The Years and Months grids — the two summary grains of the Library
// (issue #712 iOS parity). The All grain is `PhotoTimeline.tsx`.
//
// A card is a PERIOD, and tapping it is navigation, not selection: Years opens
// Months at that year, Months opens All at that month. There is no long-press,
// no drag-select and no tile chrome here, because a period is not a photograph
// — offering the photograph's gestures over a summary would promise an action
// that lands on a thing the member cannot see.
//
// THE TITLE SITS UNDER THE COVER, not on it. iOS overlays the period name on
// the key photo; this app draws text on photographs nowhere else, for the
// reason `PhotosBand.tsx` states about the band — legibility must not depend on
// what the member photographed, and a white year over a white beach is the
// failure. The label beneath is the same anatomy `PhotosLibrary`'s album cards
// already use, so a card means one thing across the app.

import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import React, { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { pageMargin, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { buildPeriods } from "./photos-zoom";
import type { PeriodGroup } from "./photos-zoom";
import type { PhotoSection } from "./timeline-source";

/** Cover aspect per grain. A year is the taller card — it is one of a handful
 *  on the page and reads as a chapter; a month is one of twelve and reads as a
 *  row, so it takes a shallower band of the screen. */
const COVER_RATIO: Record<"years" | "months", number> = {
  months: 0.52,
  years: 0.72,
};

type PeriodRow =
  | { type: "year"; key: string; title: string }
  | { type: "period"; key: string; period: PeriodGroup };

export interface PhotoPeriodGridProps {
  sections: PhotoSection[];
  grain: "years" | "months";
  /** Opens the next grain down, positioned at this period's first day. */
  onOpenPeriod: (period: PeriodGroup) => void;
  /** Bumped on every scroll gesture, so the zoom drawer can re-arm its own
   *  hide timer from this grain exactly as it does from All. */
  onScrollActivity: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export default function PhotoPeriodGrid({
  sections,
  grain,
  onOpenPeriod,
  onScrollActivity,
  refreshing = false,
  onRefresh,
}: PhotoPeriodGridProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const coverWidth = Math.max(1, width - 2 * pageMargin);
  const coverHeight = Math.round(coverWidth * COVER_RATIO[grain]);

  const rows = useMemo((): PeriodRow[] => {
    const periods = buildPeriods(sections, grain);
    if (grain === "years")
      return periods.map((period) => ({
        key: period.key,
        period,
        type: "period",
      }));
    // Months carry a sticky YEAR header, because twelve unlabelled month cards
    // in a row cannot say which year they belong to once "January" has scrolled
    // past "December".
    const out: PeriodRow[] = [];
    let currentYear: string | undefined;
    for (const period of periods) {
      if (period.year !== currentYear) {
        currentYear = period.year;
        out.push({ key: `y:${period.year}`, title: period.year, type: "year" });
      }
      out.push({ key: period.key, period, type: "period" });
    }
    return out;
  }, [grain, sections]);

  const stickyIndices = useMemo(
    () => rows.flatMap((row, index) => (row.type === "year" ? [index] : [])),
    [rows]
  );

  const renderRow = useCallback(
    ({ item }: { item: PeriodRow }) =>
      item.type === "year" ? (
        <View style={styles.yearHeader}>
          <Text style={styles.yearTitle} numberOfLines={1}>
            {item.title}
          </Text>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.period.title}, ${item.period.count}`}
          onPress={() => onOpenPeriod(item.period)}
          style={styles.card}
        >
          {item.period.cover ? (
            <Image
              source={imageSource(item.period.cover.uri)}
              {...gridImageProps(item.period.cover.uri)}
              recyclingKey={item.period.cover.id}
              style={[styles.cover, { height: coverHeight }]}
            />
          ) : (
            <View style={[styles.coverEmpty, { height: coverHeight }]} />
          )}
          <View style={styles.caption}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.period.title}
            </Text>
            <Text style={styles.cardCount} numberOfLines={1}>
              {item.period.count}
            </Text>
          </View>
        </Pressable>
      ),
    [coverHeight, onOpenPeriod, styles]
  );

  return (
    <FlashList
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      stickyHeaderIndices={stickyIndices}
      renderItem={renderRow}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onScrollBeginDrag={onScrollActivity}
      onMomentumScrollEnd={onScrollActivity}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    caption: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: 8,
      paddingTop: 8,
    },
    card: { paddingBottom: 20, paddingHorizontal: pageMargin },
    cardCount: { ...t("mono"), color: colors.textSoft },
    cardTitle: { ...t("title"), color: colors.text },
    cover: { borderRadius: radii.md, width: "100%" },
    coverEmpty: {
      backgroundColor: colors.bgSunken,
      borderRadius: radii.md,
      width: "100%",
    },
    yearHeader: {
      backgroundColor: colors.toneMat,
      height: 46,
      justifyContent: "flex-end",
      paddingBottom: 6,
      paddingHorizontal: pageMargin,
    },
    yearTitle: { ...t("eyebrow"), color: colors.text },
  });
