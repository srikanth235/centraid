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
  const rows = useMemo(
    () => skeletonRows(width, target, skeletonTileCount(width, target, height)),
    [height, target, width]
  );

  return (
    <View
      accessibilityLabel="Opening your library"
      accessibilityRole="progressbar"
      accessibilityState={{ busy: true }}
      style={styles.skeleton}
      pointerEvents="none"
    >
      {rows.map((row, index) => (
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

const styles = StyleSheet.create({
  skeleton: { flex: 1, overflow: "hidden" },
  skeletonRow: { flexDirection: "row", gap: 2, marginBottom: 2 },
  skeletonTile: { borderRadius: radii.sm },
});
