// The justified timeline (Photos v4 handoff §4).
//
// Rows are packed from real aspect ratios to the member's rung, then scaled to
// fill the width exactly. Nothing is cropped to a square. Month headers are
// sticky with a mono count; day sub-labels carry a count and an optional
// place. The scrub rail overlays the grid rather than taking a column from it.
//
// The grouping, the packing and the row list are all in `timeline-rows.ts` and
// `justify.ts`; this file is the view and the gestures over them.

import { FlashList } from "@shopify/flash-list";
import type { FlashListRef } from "@shopify/flash-list";
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
  monthHeaderIndices,
  monthLabelAt,
  rowTops,
} from "./timeline-rows";
import type { TimelineRow } from "./timeline-rows";
import type { PhotoAsset, PhotoSection } from "./timeline-source";

// Where the rail's drag surface starts and ends inside the content area.
const RAIL_TOP = 8;

/** Hit-test a gesture point to the asset under it. Shared by tap-to-open and
 *  long-press drag-select so both agree on geometry.
 *
 * `x` arrives in the GESTURE layer's coordinates, which span the whole stage;
 * the tiles start one page margin in. Forgetting that subtraction is silent —
 * every tap simply resolves to the tile one position to its left, and only at
 * the very edge of a row does it resolve to nothing at all. */
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
  let position = Math.max(0, x - pageMargin);
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

// Built outside any component: `Gesture.Pinch()` & friends are capitalised
// factories whose builder chain then MUTATES the object — a shape the React
// compiler rejects inside a render body. Everything the handlers close over is
// passed in explicitly.
function buildTimelineGestures(
  rung: Rung,
  onRung: (next: Rung) => void,
  onTap: (x: number, y: number) => void,
  onDrag: (x: number, y: number) => void
): ReturnType<typeof Gesture.Simultaneous> {
  // Pinch resolves to a STEPPER PRESS, not a continuous zoom (§4.2): the
  // gesture and the pointer control must not be able to drift to different
  // rungs, and every gesture keeps a pointer equivalent.
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
  /** The gateway is not answering. Passed straight through to every tile,
   *  where it turns `on the gateway` from steady-state provenance into the
   *  explanation for a tile that cannot paint. */
  unreachable?: boolean;
}

export default function PhotoTimeline({
  sections,
  onOpen,
  selection,
  onSelectionChange,
  placeNames,
  refreshing = false,
  onRefresh,
  unreachable = false,
}: PhotoTimelineProps): React.JSX.Element {
  // The rung and the vault facts are read here, not passed in: a shelf is the
  // same timeline under a filter (§5), so every one of them must show the size
  // the member chose and mark tiles by the same rule, without each screen
  // re-wiring it.
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
  // The grid is packed to the CONTENT column, not to the stage. The handoff is
  // explicit: `contentW = stageW - pad*2` (proto:4656) with `pad = R.margin.m`
  // = 18 on the phone, and the whole scroll column carries that margin
  // (proto:5566 — `padding: 16px 18px 24px`). Packing to the full window width
  // instead ran the tiles edge to edge while the month and day headers stayed
  // inset, so the grid and its own headers disagreed about where the page
  // begins — and every row was justified 36pt too wide.
  const contentWidth = Math.max(1, width - 2 * pageMargin);
  const rows = useMemo(
    () => buildRows(sections, contentWidth, target, placeNames),
    [contentWidth, placeNames, sections, target]
  );
  const stickyIndices = useMemo(() => monthHeaderIndices(rows), [rows]);
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
      <View style={styles.fill}>
        <FlashList
          ref={list}
          data={rows}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          stickyHeaderIndices={stickyIndices}
          renderItem={({ item }) =>
            item.type === "month" ? (
              <View style={styles.month}>
                <Text style={styles.monthTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.count} numberOfLines={1}>
                  {item.count}
                </Text>
              </View>
            ) : item.type === "day" ? (
              <View style={styles.day}>
                <Text style={styles.dayTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.count} numberOfLines={1}>
                  {item.count}
                </Text>
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
                    selected={selection.has(tile.asset.id)}
                    selecting={selecting}
                    vaults={vaults}
                    unreachable={unreachable}
                    onOpen={handleOpen}
                    onSelect={toggle}
                  />
                ))}
              </View>
            )
          }
          onScrollBeginDrag={() => setScrubLabel("")}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onScroll={(event) => {
            scrollOffset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        />
        {/* The rail spans this surface, and this surface already ends above the
            band — the band is a sibling of the scroll region, not an overlay on
            it, so the rail's foot needs no band-sized reserve of its own. */}
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
    count: { ...t("mono"), color: colors.textSoft },
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
      // Sticky over the grid, so it needs the page's own opaque ground.
      backgroundColor: colors.toneMat,
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
      // The same margin the month and day headers carry, so the grid's edge
      // and its headers' edge are one line down the page.
      paddingHorizontal: pageMargin,
    },
    selectDay: { ...t("control"), color: colors.text },
    selectDayTarget: { justifyContent: "center", minHeight: 44 },
  });
