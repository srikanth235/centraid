import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing } from "../theme";

const BONE_HEIGHT = 11;

export const styles = StyleSheet.create({
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginTop: spacing[4],
    overflow: "hidden",
  },
  bone: { borderRadius: radii.sm, height: BONE_HEIGHT },
  row: {
    borderTopWidth: borders.hairline,
    justifyContent: "center",
    minHeight: metrics.row,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowFirst: { borderTopWidth: 0 },
});
