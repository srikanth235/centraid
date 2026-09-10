// THE LIBRARY DESTINATION'S BODY (#1015 Wave 2).
//
// Lifted out of `PhotosHome.tsx` when the room took the header, the band and
// the selection bar: what is left of that screen is wiring, and this is the
// one branchy view it still drew inline. It decides nothing — every state it
// renders is handed to it — so the order of loading, empty-library,
// emptied-by-filter and content is readable in one screenful.

import React from "react";
import { View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import PhotoGrainView from "./PhotoGrainView";
import type { Rung } from "./photos-rungs";
import PhotosGridSkeleton from "./PhotosGridSkeleton";
import type { makeStyles } from "./PhotosHome.styles";
import PhotoTimeline from "./PhotoTimeline";
import type { GrainPeriod, TimelineGrain } from "./timeline-grains";
import type { PhotoSection } from "./timeline-model";
import type { PhotoAsset } from "./timeline-source";
import { GRAIN_CONTROL_SLOT } from "./TimelineGrainControl";

export interface PhotosLibraryBodyProps {
  styles: ReturnType<typeof makeStyles>;
  /** The read's own words when the vault cannot be reached (S14). */
  offline: boolean;
  loading: boolean;
  /** Every section the library holds, before the filter. */
  sections: readonly PhotoSection[];
  /** What the filter left — an empty one has its own sentence. */
  visibleSections: PhotoSection[];
  grain: TimelineGrain;
  placeDay: string | undefined;
  refreshing: boolean;
  selecting: boolean;
  selection: Set<string>;
  /** The tile geometry the skeleton must land at, so nothing reflows. */
  rung: Rung;
  onPlaceDay: (day: string | undefined) => void;
  onRefresh: () => void;
  onSelectionChange: (next: Set<string>) => void;
  onOpen: (asset: PhotoAsset) => void;
  onOpenPeriod: (period: GrainPeriod) => void;
}

export default function PhotosLibraryBody({
  styles,
  offline,
  loading,
  sections,
  visibleSections,
  grain,
  placeDay,
  refreshing,
  selecting,
  selection,
  rung,
  onPlaceDay,
  onRefresh,
  onSelectionChange,
  onOpen,
  onOpenPeriod,
}: PhotosLibraryBodyProps): React.JSX.Element {
  // The grid IS the loading state (§14): skeleton tiles at the rung's real
  // geometry, so nothing reflows when the bytes land. Never a spinner (§18).
  if (loading) return <PhotosGridSkeleton rung={rung} />;
  if (sections.length === 0)
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>
          {offline ? "No cached vault photographs" : "Your library starts here"}
        </Text>
        <Text style={styles.bodyText}>
          {offline
            ? "Camera-roll photographs remain available — reconnect to check the vault."
            : "Camera-roll photographs appear instantly; hold any one to back it up."}
        </Text>
      </View>
    );
  // The filter emptied the grid, not the library — its own sentence, never the
  // empty-library copy above.
  if (visibleSections.length === 0)
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No favorites yet</Text>
        <Text style={styles.bodyText}>
          Photographs you mark as a favorite appear here.
        </Text>
      </View>
    );
  if (grain === "all")
    return (
      <PhotoTimeline
        sections={visibleSections}
        selection={selection}
        refreshing={refreshing}
        scrollToDay={placeDay}
        onVisibleDay={onPlaceDay}
        // Room for the floating grain control, on the same condition it mounts
        // under in `PhotosHome`.
        footerInset={selecting ? 0 : GRAIN_CONTROL_SLOT}
        onRefresh={onRefresh}
        onSelectionChange={onSelectionChange}
        onOpen={onOpen}
      />
    );
  // The same sections the grid above draws, grouped into periods — never a
  // second query, or the grains could disagree.
  return (
    <PhotoGrainView
      sections={visibleSections}
      grain={grain}
      focusDay={placeDay}
      refreshing={refreshing}
      onRefresh={onRefresh}
      onOpenPeriod={onOpenPeriod}
    />
  );
}
