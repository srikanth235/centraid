import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

const TRACK_HEIGHT = spacing[2];

export const styles = StyleSheet.create({
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    gap: spacing[4],
    padding: spacing[4],
  },
  fill: { borderRadius: radii.pill, height: "100%" },
  head: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
  },
  label: { ...t("annotLabel"), flexShrink: 1 },
  row: { gap: spacing[1] },
  share: { ...t("mono"), flexGrow: 0, flexShrink: 0 },
  track: {
    borderRadius: radii.pill,
    height: TRACK_HEIGHT,
    overflow: "hidden",
  },
  value: t("mono"),
});
