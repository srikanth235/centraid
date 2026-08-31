// The justified timeline (§4): rows packed from real aspect ratios and scaled to
// fill the width — nothing is cropped to a square. Grouping and packing live in
// `timeline-rows.ts` and `justify.ts`; this file is the view and the gestures.

import { FlashList } from "@shopify/flash-list";
import type { FlashListRef, ListRenderItemInfo } from "@shopify/flash-list";
import * as Haptics from "expo-haptics";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

import { Text } from "../../kit/components/NativeText";
import {
  PHOTO_TILE_HANDLES,
  TEST_IDS,
  TEST_ID_PREFIXES,
} from "../../kit/test-ids";
import { pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { usePhotosRung } from "./photos-rung-store";
import type { Rung } from "./photos-rungs";
import { pinchRung, rungHeight } from "./photos-rungs";
import { useVaultFacts } from "./photos-vaults";
import PhotoTile from "./PhotoTile";
import ScrubRail from "./ScrubRail";
import { addDragSelection } from "./timeline-model";
import {
  buildRows,
  dayAtOffset,
  monthHeaderIndices,
  monthLabelAt,
  rowTops,
} from "./timeline-rows";
import type { TimelineRow } from "./timeline-rows";
import type { PhotoAsset, PhotoSection } from "./timeline-source";

const RAIL_TOP = 8;

/**
 * Positional handles for the FIRST few tiles — `photos-tile-0` … — so a flow can
 * open a photograph without keying on a filename the seed owns.
 *
 * BOUNDED BY CONSTRUCTION. This grid is the frame-drop surface
 * (`tests/agent-e2e-mobile/flows/scroll-frames.mjs`), so the walk stops as soon
 * as `PHOTO_TILE_HANDLES` ids exist: the cost is the same on a 90-photograph
 * library and a 90,000-photograph one, which is the rule for anything that runs
 * beside a render (CONSTITUTION "nothing whose cost scales with vault size").
 */
function tileHandles(
  rows: readonly TimelineRow[]
): ReadonlyMap<string, string> {
  const handles = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== "assets") continue;
    for (const tile of row.tiles) {
      handles.set(
        tile.asset.id,
        `${TEST_ID_PREFIXES.photosTile}${handles.size}`
      );
      if (handles.size >= PHOTO_TILE_HANDLES) return handles;
    }
  }
  return handles;
}

/** `x` is already row-relative because the row is full-bleed. If the row regains
 *  an inset, subtract it here or every tap resolves one tile to the left. */
function assetAt(
  rows: readonly TimelineRow[],
  tops: readonly number[],
  scrollY: number,
  x: number,
  y: number
): PhotoAsset | undefined {
  const cursor = scrollY + y;
  let lo = 0;
  let hi = rows.length - 1;
  let rowIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const top = tops[mid]!;
    const bottom = top + rows[mid]!.height;
    if (cursor < top) hi = mid - 1;
    else if (cursor >= bottom) lo = mid + 1;
    else {
      rowIndex = mid;
      break;
    }
  }
  const row = rowIndex >= 0 ? rows[rowIndex] : undefined;
  if (!row || row.type !== "assets") return undefined;
  let position = Math.max(0, x);
  for (const tile of row.tiles) {
    if (position <= tile.width) return tile.asset;
    position -= tile.width + 2;
  }
  return row.tiles.at(-1)?.asset;
}

function toggleSelection(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// Outside any component: the builder chain MUTATES the object, which the React
// compiler rejects in a render body.
function buildTimelineGestures(
  rung: Rung,
  onRung: (next: Rung) => void,
  onTap: (x: number, y: number) => void,
  onDrag: (x: number, y: number) => void
): ReturnType<typeof Gesture.Simultaneous> {
  // Pinch resolves to a STEPPER PRESS, not a continuous zoom (§4.2).
  const pinch = Gesture.Pinch().onEnd(({ scale }) => {
    const next = pinchRung(rung, scale);
    if (next !== rung) runOnJS(onRung)(next);
  });
  const tap = Gesture.Tap().onEnd((event, success) => {
    if (success) runOnJS(onTap)(event.x, event.y);
  });
  const drag = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(({ x, y }) => runOnJS(onDrag)(x, y))
    .onUpdate(({ x, y }) => runOnJS(onDrag)(x, y));
  return Gesture.Simultaneous(pinch, Gesture.Exclusive(drag, tap));
}

function TimelineGestureLayer({
  rung,
  onRung,
  onTap,
  onDrag,
  children,
}: {
  rung: Rung;
  onRung: (next: Rung) => void;
  onTap: (x: number, y: number) => void;
  onDrag: (x: number, y: number) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <GestureDetector
      gesture={buildTimelineGestures(rung, onRung, onTap, onDrag)}
    >
      {children}
    </GestureDetector>
  );
}

export interface PhotoTimelineProps {
  sections: PhotoSection[];
  onOpen: (asset: PhotoAsset) => void;
  selection: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  placeNames?: ReadonlyMap<string, string>;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Applied once per distinct value, so a member who scrolls away is not
   *  yanked back on the next render. */
  scrollToDay?: string;
  /** Reported on scroll END, never `onScroll`: a per-frame state bump would
   *  re-render the screen sixty times a second. */
  onVisibleDay?: (day: string) => void;
  footerInset?: number;
}

export default function PhotoTimeline({
  sections,
  onOpen,
  selection,
  onSelectionChange,
  placeNames,
  refreshing = false,
  onRefresh,
  scrollToDay,
  onVisibleDay,
  footerInset = 0,
}: PhotoTimelineProps): React.JSX.Element {
  // Read here, not passed in: every shelf is the same timeline (§5).
  const [rung, onRungChange] = usePhotosRung();
  const vaults = useVaultFacts();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const [scrubLabel, setScrubLabel] = useState("");
  const [scrubPosition, setScrubPosition] = useState(0);
  const list = useRef<FlashListRef<TimelineRow>>(null);
  const scrollOffset = useRef(0);

  const selectionRef = useRef(selection);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const target = rungHeight(rung, "phone");
  // Full STAGE width: only the month and day HEADERS keep `pageMargin`.
  const contentWidth = Math.max(1, width);
  const rows = useMemo(
    () => buildRows(sections, contentWidth, target, placeNames),
    [contentWidth, placeNames, sections, target]
  );
  const stickyIndices = useMemo(() => monthHeaderIndices(rows), [rows]);
  const handles = useMemo(() => tileHandles(rows), [rows]);
  const tops = useMemo(() => rowTops(rows), [rows]);
  const selecting = selection.size > 0;

  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  const handleOpen = useCallback(
    (asset: PhotoAsset): void => onOpenRef.current(asset),
    []
  );
  const toggle = useCallback(
    (asset: PhotoAsset): void => {
      void Haptics.selectionAsync();
      onSelectionChange(toggleSelection(selectionRef.current, asset.id));
    },
    [onSelectionChange]
  );

  const dragSelect = (x: number, y: number): void => {
    const asset = assetAt(rows, tops, scrollOffset.current, x, y);
    if (!asset || selectionRef.current.has(asset.id)) return;
    void Haptics.selectionAsync();
    const next = addDragSelection(selectionRef.current, asset.id);
    // Written straight through so the next onUpdate of the same drag sees it.
    selectionRef.current = next;
    onSelectionChange(next);
  };

  const tapAsset = (x: number, y: number): void => {
    const asset = assetAt(rows, tops, scrollOffset.current, x, y);
    if (!asset) return;
    if (selectionRef.current.size > 0) toggle(asset);
    else handleOpen(asset);
  };

  // The MOUNT landing takes FlashList's own `initialScrollIndex`: an effect's
  // `scrollToIndex` runs before the list has measured and silently no-ops.
  const initialLanding = useMemo(() => {
    if (!scrollToDay) return undefined;
    const monthKey = `m:${scrollToDay.slice(0, 7)}`;
    const index = rows.findIndex(
      (row) => row.key === monthKey || row.key === `d:${scrollToDay}`
    );
    return index < 0 ? undefined : index;
  }, [rows, scrollToDay]);
  // NOT pre-marked as landed: `initialScrollIndex` uses ESTIMATED heights and
  // drifts by years; the effect below corrects it.
  const landedDay = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!scrollToDay || landedDay.current === scrollToDay) return;
    const monthKey = `m:${scrollToDay.slice(0, 7)}`;
    const index = rows.findIndex(
      (row) => row.key === monthKey || row.key === `d:${scrollToDay}`
    );
    if (index < 0) return;
    landedDay.current = scrollToDay;
    // A frame later: a synchronous `scrollToIndex` on mount no-ops.
    const frame = requestAnimationFrame(() => {
      void list.current?.scrollToIndex({
        animated: false,
        index,
        viewPosition: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, scrollToDay]);

  const notePlace = (): void => {
    if (!onVisibleDay) return;
    const day = dayAtOffset(rows, tops, scrollOffset.current);
    if (day !== undefined) onVisibleDay(day);
  };

  // Stable across every render this list does NOT depend on — a scrub label, a
  // refresh flag, a scroll offset. Inline in the JSX, `renderItem` was a new
  // function each time, which is FlashList's signal that every mounted cell
  // needs re-rendering, and `PhotoTile`'s memo never got to bail out.
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<TimelineRow>): React.JSX.Element =>
      item.type === "month" ? (
        <View style={styles.month}>
          {/* The month's NAME and nothing else (see `timeline-rows.ts`). */}
          <Text style={styles.monthTitle} numberOfLines={1}>
            {item.title}
          </Text>
        </View>
      ) : item.type === "day" ? (
        <View style={styles.day}>
          <Text style={styles.dayTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.place ? (
            <Text style={styles.place} numberOfLines={1}>
              {item.place}
            </Text>
          ) : null}
          {selecting ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Select ${item.title}`}
              onPress={() =>
                onSelectionChange(
                  new Set([
                    ...selection,
                    ...item.assets.map((asset) => asset.id),
                  ])
                )
              }
              style={styles.selectDayTarget}
            >
              <Text style={styles.selectDay}>Select day</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.row}>
          {item.tiles.map((tile) => (
            <PhotoTile
              key={tile.asset.id}
              asset={tile.asset}
              width={tile.width}
              height={tile.height}
              rung={rung}
              testID={handles.get(tile.asset.id)}
              selected={selection.has(tile.asset.id)}
              selecting={selecting}
              vaults={vaults}
              onOpen={handleOpen}
              onSelect={toggle}
            />
          ))}
        </View>
      ),
    [
      handleOpen,
      handles,
      onSelectionChange,
      rung,
      selecting,
      selection,
      styles,
      toggle,
      vaults,
    ]
  );

  const scrub = (ratio: number): void => {
    const index = Math.min(
      rows.length - 1,
      Math.max(0, Math.floor(ratio * rows.length))
    );
    void list.current?.scrollToIndex({
      index,
      animated: false,
      viewPosition: 0,
    });
    setScrubPosition(ratio);
    setScrubLabel(monthLabelAt(rows, index));
  };

  return (
    <TimelineGestureLayer
      rung={rung}
      onRung={onRungChange}
      onTap={tapAsset}
      onDrag={dragSelect}
    >
      <View style={styles.fill} testID={TEST_IDS.photos.grid}>
        <FlashList
          initialScrollIndex={initialLanding}
          ref={list}
          data={rows}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          stickyHeaderIndices={stickyIndices}
          renderItem={renderRow}
          onScrollBeginDrag={() => setScrubLabel("")}
          onMomentumScrollEnd={notePlace}
          onScrollEndDrag={notePlace}
          contentContainerStyle={{ paddingBottom: footerInset }}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onScroll={(event) => {
            scrollOffset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        />
        {/* The band is a sibling of the scroll region, so the rail's foot needs
            no band-sized reserve. */}
        <ScrubRail
          label={scrubLabel}
          position={scrubPosition}
          onScrub={scrub}
          onScrubEnd={() => setScrubLabel("")}
          top={RAIL_TOP}
          bottom={RAIL_TOP}
        />
      </View>
    </TimelineGestureLayer>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    place: { ...t("small"), color: colors.textFaint },
    day: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: 8,
      height: 34,
      paddingHorizontal: pageMargin,
    },
    dayTitle: { ...t("small"), color: colors.textSoft },
    fill: { flex: 1 },
    month: {
      alignItems: "baseline",
      backgroundColor: colors.bg,
      flexDirection: "row",
      gap: 8,
      height: 46,
      paddingHorizontal: pageMargin,
      paddingTop: 12,
    },
    monthTitle: { ...t("eyebrow"), color: colors.text },
    row: {
      flexDirection: "row",
      gap: 2,
      marginBottom: 2,
      // No horizontal padding: the tiles are full-bleed. Never share the
      // headers' style.
    },
    selectDay: { ...t("control"), color: colors.text },
    selectDayTarget: { justifyContent: "center", minHeight: 44 },
  });
