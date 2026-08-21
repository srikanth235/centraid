// Geometry for the distribution rows (#775).
//
// The phone STACKS what the shell lays out in one line — label and share on the
// first line, the bar under it, the figure under that. A 390pt screen has no
// room for a fixed key column, a full-width bar and two numerics side by side;
// squeezing them onto one line is how a model name becomes four characters and
// an ellipsis.

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

/** The bar's own height. Thin enough to read as a measure rather than a
 *  control, and the one dimension the spacing scale genuinely owns. */
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
  // One line, always: a wrapping label would step the row off its own bar.
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
