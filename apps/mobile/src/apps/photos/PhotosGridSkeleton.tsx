// The library, opening (Photos v4 handoff §14, proto:3993-4033).
//
// Packed by `justify()` at the member's own rung from a FIXED aspect sequence
// (`skeleton-rows.ts`), painted in `--skel`. No shimmer and no randomness:
// motion in a placeholder says something is happening when nothing is, and a
// grid that repacks itself on every render is the reflow §14 exists to forbid.
//
// Deliberately not a `FlashList` — there is nothing to virtualise, and one
// screenful is all that is ever drawn.
//
// Lifted out of `PhotosHome.tsx` (issue #712, P13): the home screen grew a
// second thing that can occupy the grid's slot — the permission takeover — and
// the placeholder is a self-contained shape with its own styles, so it is the
// half that leaves.

import React, { useMemo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import { useTheme, radii } from "../../kit/theme";
import { rungHeight } from "./photos-rungs";
import type { Rung } from "./photos-rungs";
import { skeletonRows, skeletonTileCount } from "./skeleton-rows";

export default function PhotosGridSkeleton({
  rung,
}: {
  rung: Rung;
}): React.JSX.Element {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const target = rungHeight(rung, "phone");
  // The window's full height, not the slot's: the slot is genuinely shorter
  // than the window (the band is a sibling that takes its own room), so this
  // packs at most a row or two more than fit — and `styles.skeleton` clips
  // them. Overshooting a placeholder is invisible; undershooting leaves a bare
  // strip above the band while the library opens.
  const rows = useMemo(
    () => skeletonRows(width, target, skeletonTileCount(width, target, height)),
    [height, target, width]
  );

  return (
    <View
      accessibilityLabel="Opening your library"
      accessibilityRole="progressbar"
      style={styles.skeleton}
      pointerEvents="none"
    >
      {rows.map((row, index) => (
        // Row index is the only identity a placeholder row has, and the list is
        // fixed for the life of the loading state.
        <View key={`skeleton-row-${index}`} style={styles.skeletonRow}>
          {row.map((tile) => (
            <View
              key={tile.asset.id}
              style={[
                styles.skeletonTile,
                {
                  backgroundColor: colors.skel,
                  height: tile.height,
                  width: tile.width,
                },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

// The same 2px gutter the real grid uses, on both axes — the placeholder and
// the photographs occupy identical boxes.
const styles = StyleSheet.create({
  skeleton: { flex: 1, overflow: "hidden" },
  skeletonRow: { flexDirection: "row", gap: 2, marginBottom: 2 },
  skeletonTile: { borderRadius: radii.sm },
});
