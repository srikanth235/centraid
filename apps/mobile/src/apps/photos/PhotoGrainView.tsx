// THE YEARS AND MONTHS VIEWS — the two summary grains of the Library
// (issue #712 iOS parity). The All grain is `PhotoTimeline.tsx`; the grouping
// they both draw from is `timeline-grains.ts`.
//
// A card is a PERIOD, and tapping it is navigation, not selection: Years opens
// Months at that year, Months opens All at that month. There is no long-press,
// no drag-select and no tile chrome here, because a period is not a photograph
// — offering the photograph's gestures over a summary would promise an action
// that lands on a thing the member cannot see.
//
// THE TWO GRAINS ARE DIFFERENT SHAPES BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
// A year is a chapter: one full-width card, a handful on the page, its name in
// the display rung on the cover itself the way iOS states it. A month is one of
// twelve: two to a row, its name BENEATH the cover, because display type across
// a half-width card either wraps or shrinks to something no longer in the ramp
// — and a legibility argument that has to be re-won at every card width is not
// a rule, it is a hope.
//
// TEXT ON A PHOTOGRAPH NEEDS ITS OWN GROUND. The year label is the one place in
// this app where type sits over an image, and it only survives there because it
// sits on a scrim: a white year over a white beach is the failure mode
// `PhotosBand.tsx` refuses glass for, and it does not stop being the failure
// mode here. The scrim is not decoration; it is what makes the overlay
// permissible at all.
//
// YEAR HEADERS ONLY WHEN THERE IS A YEAR TO DISAMBIGUATE. A library that lives
// entirely inside one year gets no headers over its Months grid — a header that
// says the only thing on the page is chrome, and a single-year library then
// reads exactly as a plain month grid should.

import { FlashList } from "@shopify/flash-list";
import type { FlashListRef } from "@shopify/flash-list";
import { Image } from "expo-image";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { gridImageProps } from "../../kit/media/grid-image";
import { imageSource } from "../../kit/media/media-source";
import { pageMargin, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { buildPeriods, periodContaining } from "./timeline-grains";
import type { GrainPeriod, SummaryGrain } from "./timeline-grains";
import type { PhotoSection } from "./timeline-model";
import { GRAIN_CONTROL_SLOT } from "./TimelineGrainControl";

/** Cover aspect per grain. A year is the taller card — it is one of a handful
 *  on the page and reads as a chapter; a month is one of a dozen at half the
 *  width, so it takes a near-square block that packs two to a row without
 *  either one dominating. */
const YEAR_COVER_RATIO = 0.72;
const MONTH_COVER_RATIO = 1;
/** The gutter between the two month columns, and beneath every card. */
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

/**
 * Rows for the Months grid: two cards to a row, under year headers when the
 * library spans more than one year.
 *
 * Pairing happens WITHIN a year, never across one — a row that straddled a
 * header would put December and the previous January side by side under a
 * heading true of only half of it.
 */
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

/** The row a period sits in — how a grain switch lands on the period the
 *  member was already looking at rather than at the top of the library. */
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
  /** Opens the next grain down, positioned at this period's first day. */
  onOpenPeriod: (period: GrainPeriod) => void;
  /** The `PhotoSection.day` the member's place resolves to — see
   *  `timeline-grains.ts` on reverse anchoring. The period containing it is
   *  scrolled into view once per distinct value, so a member who then scrolls
   *  away is not yanked back on the next render. */
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
            // The scrim, then the year — see the header on why the overlay is
            // only permissible with a ground of its own.
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
          {/* The odd month out leaves its column EMPTY rather than stretching
              across the row: a wider card would read as a bigger month. */}
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
    // ONE QUIET LINE, NOT A CARD. Reached when every photograph in the library
    // is undated: they are all there in All, but not one of them has a place in
    // the calendar, so Years and Months have nothing to summarise. A card would
    // be a period that is not a period; a blank surface would be a bug.
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyLine}>
          These photographs carry no capture date, so they have no year or
          month. They are all in All.
        </Text>
      </View>
    );

  return (
    <FlashList
      ref={list}
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.type}
      stickyHeaderIndices={stickyIndices}
      renderItem={renderRow}
      refreshing={refreshing}
      onRefresh={onRefresh}
      // The grain control floats permanently over this list's foot — it owes
      // the last card the room it takes (`GRAIN_CONTROL_SLOT`).
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
    // `flexShrink` on the title, not the count: a Text inside a row keeps
    // its intrinsic width unless told otherwise, and these rows sit inside
    // a fixed HALF-WIDTH column — observed on device as "December 2025"
    // running under its neighbour's caption. The month name ellipsises;
    // the count is short mono and never should.
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
