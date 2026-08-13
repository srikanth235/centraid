// Geometry for the per-route standing status line (#765).
//
// Anatomy is `screens/home/HomeStatusLine`'s, one rung looser: a fixed row, a
// hairline above it, a small neutral dot, the numeric register, and (unlike
// Home's) one optional inline verb — which is why the row's height is a
// MINIMUM here rather than a fixed 30: the verb is a control and controls do
// not go under the touch floor.

import { StyleSheet } from "react-native";

import { borders, metrics, pageMargin, radii, spacing, t } from "../theme";

/** The status dot, 5pt — the handoff's `statusDotStyle`, not 6. */
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
