import { StyleSheet } from "react-native";

import { borders, metrics, pageMargin, radii, spacing, t } from "../theme";

const DOT = 5;

export const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: metrics.controlTouch,
  },
  actionText: {
    ...t("mono"),
    textDecorationLine: "underline",
  },
  dot: { borderRadius: radii.pill, height: DOT, width: DOT },
  row: {
    alignItems: "center",
    borderTopWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[2],
    minHeight: metrics.controlTouch,
    paddingHorizontal: pageMargin,
  },
  text: { ...t("mono"), flex: 1, minWidth: 0 },
});
