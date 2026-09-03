import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  chip: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    flexGrow: 0,
    flexShrink: 0,
    height: metrics.controlTouch,
    justifyContent: "center",
    paddingHorizontal: spacing[3],
  },
  label: t("body"),
  labelOn: t("labelOn"),
  monoLabel: { ...t("annotLabel"), fontVariant: t("mono").fontVariant },
  monoLabelOn: { ...t("annotLabelOn"), fontVariant: t("mono").fontVariant },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingBottom: spacing[3],
  },
});
