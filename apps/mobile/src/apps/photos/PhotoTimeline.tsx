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
  dayAtOffset,
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
 * the tile ROW now starts flush with that same stage — full-bleed, no page
 * margin — so `x` already IS row-relative. If the row ever regains an inset
 * (a `paddingHorizontal` on `styles.row`), this must subtract it again or
 * every tap resolves to the tile one position to its left. */
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
  /** A `PhotoSection.day` to land on — how the Years and Months grains hand a
   *  period back to All (`timeline-grains.ts`). Applied once per distinct
   *  value, so a member who then scrolls away is not yanked back on the next
   *  render. */
  scrollToDay?: string;
  /** The day the member has scrolled to, reported so a switch UP to Years or
   *  Months can land on the period holding it (`timeline-grains.ts`).
   *
   *  Deliberately NOT wired to `onScroll`: that fires every frame, and a state
   *  bump per frame would re-render the whole screen sixty times a second to
   *  say something only read when the grain changes. Scroll END is when the
   *  member has arrived, and arriving is the only moment the answer changes in
   *  a way anyone acts on. */
  onVisibleDay?: (day: string) => void;
  /** Room to leave at the foot for a control floating over this grid — the
   *  Library's permanent grain control (`TimelineGrainControl.tsx`). Zero
   *  everywhere else, because everywhere else nothing floats there. */
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
  // The grid is packed to the full STAGE width, not the content column: iOS
  // Photos' own Library tab runs the photographs edge to edge, and the
  // photographs are the content the member came for — the edge is theirs.
  // Only the month/day HEADERS (labels about the content) keep the page's own
  // `pageMargin`, in their own styles below, so they read as text on a page
  // while the grid beneath them reads as a wall of photographs.
  const contentWidth = Math.max(1, width);
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

  // Landing on a period handed over by the zoom drawer. The row list has to
  // exist first — `rows` is rebuilt whenever the width, rung or sections change
  // — so this reads it from the same render rather than firing on mount alone.
  // The MOUNT landing takes FlashList's own `initialScrollIndex`, not the
  // effect below: a grain switch remounts this list, and a `scrollToIndex`
  // fired from an effect lands before the list has measured anything — it
  // no-ops silently, which read on device as "tapped July 2025, arrived at
  // the top of 2026". `initialScrollIndex` is applied by the list itself at
  // layout time, which is the one moment that cannot be too early. Lazy
  // useState so it is computed exactly once, from the first render's rows.
  // The COARSE first paint. FlashList reads this only while mounting, so a
  // plain memo is right: recomputing on later renders costs a findIndex and
  // changes nothing, whereas a ref would be read during render and a state
  // pair would carry a setter that must never be called.
  const initialLanding = useMemo(() => {
    if (!scrollToDay) return undefined;
    const monthKey = `m:${scrollToDay.slice(0, 7)}`;
    const index = rows.findIndex(
      (row) => row.key === monthKey || row.key === `d:${scrollToDay}`
    );
    return index < 0 ? undefined : index;
  }, [rows, scrollToDay]);
  // Deliberately NOT pre-marked as landed: `initialScrollIndex` positions by
  // ESTIMATED row heights, and over a long variable-height timeline the
  // estimate drifts by whole years (observed: tapped July 2025, first paint
  // landed in August 2012). The effect below runs after mount with real
  // measurements around the coarse position and corrects the landing.
  const landedDay = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!scrollToDay || landedDay.current === scrollToDay) return;
    // The period's own MONTH header, not its first day row: a period always
    // starts at a month boundary (`buildPeriods` anchors on the first section
    // of the group), and landing on the header means the member arrives with
    // the label that names where they are already on screen. The day row is
    // the fallback for a filtered grid whose header was packed away.
    const monthKey = `m:${scrollToDay.slice(0, 7)}`;
    const index = rows.findIndex(
      (row) => row.key === monthKey || row.key === `d:${scrollToDay}`
    );
    if (index < 0) return;
    landedDay.current = scrollToDay;
    // A frame later, not now: on a fresh mount this effect fires before the
    // list has measured anything and a synchronous scrollToIndex silently
    // no-ops. One frame is enough because `initialScrollIndex` already
    // painted the neighbourhood, so real item sizes exist to scroll against.
    const frame = requestAnimationFrame(() => {
      void list.current?.scrollToIndex({
        animated: false,
        index,
        viewPosition: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, scrollToDay]);

  // Where the member has come to rest, in the one vocabulary the summary
  // grains also speak — a `PhotoSection.day`. Reported on scroll end only; see
  // `onVisibleDay`'s own comment for why not on every frame.
  const notePlace = (): void => {
    if (!onVisibleDay) return;
    const day = dayAtOffset(rows, tops, scrollOffset.current);
    if (day !== undefined) onVisibleDay(day);
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
          initialScrollIndex={initialLanding}
          ref={list}
          data={rows}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          stickyHeaderIndices={stickyIndices}
          renderItem={({ item }) =>
            item.type === "month" ? (
              <View style={styles.month}>
                {/* The month's NAME and nothing else — see `timeline-rows.ts`
                    on why the tally left the timeline. */}
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
                    selected={selection.has(tile.asset.id)}
                    selecting={selecting}
                    vaults={vaults}
                    onOpen={handleOpen}
                    onSelect={toggle}
                  />
                ))}
              </View>
            )
          }
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
    // A place is prose, not a figure — so it takes the day label's own sans
    // face rather than the mono/tabular register a count sits in.
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
      // Sticky over the grid, so it needs the page's own opaque ground.
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
      // No horizontal padding, deliberately: the tiles are full-bleed (see
      // `contentWidth` above). The month and day headers below keep their own
      // `paddingHorizontal: pageMargin` — this row must NOT share their style,
      // or the tiles would be pulled back in with them.
    },
    selectDay: { ...t("control"), color: colors.text },
    selectDayTarget: { justifyContent: "center", minHeight: 44 },
  });
