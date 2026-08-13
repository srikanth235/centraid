// Geometry for the runs chart (#765, spec §9/§11 mobile branch).
//
// Plain Views, no SVG: the chart is ten rectangles and two rules, and a vector
// runtime for that is a dependency the screen would carry for a gradient it is
// not allowed to draw anyway (`succeeded` is tertiary INK, `failed` is `net`,
// and nothing here is chromatic beyond that one segment).

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

/** The phone's chart geometry, from the reference's mobile branch: 116pt tall
 *  (vs 148 under a pointer), a 3pt gutter between columns (vs 5), and TEN
 *  columns whatever the window — a 90-day window on a 390pt screen is a
 *  sampled shape, not ninety bars two points wide. Layout dimensions; they
 *  are not tokens because no second consumer exists. */
export const CHART_HEIGHT = 116;
export const COLUMN_GAP = 3;
export const COLUMN_COUNT = 10;

/** A column's own internal seam, between the failed cap and the run below it.
 *  One point, so the stack reads as two facts rather than one gradient. */
const SEGMENT_SEAM = 1;

export const styles = StyleSheet.create({
  axis: { flexDirection: "row", justifyContent: "space-between" },
  axisLabel: t("mono"),
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    gap: spacing[2],
    padding: spacing[3],
  },
  chart: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: COLUMN_GAP,
    height: CHART_HEIGHT,
  },
  column: {
    flex: 1,
    gap: SEGMENT_SEAM,
    height: "100%",
    justifyContent: "flex-end",
    minWidth: 0,
  },
  // Only the TOP of a column is rounded — the base sits on the axis.
  failed: { borderTopEndRadius: radii.sm, borderTopStartRadius: radii.sm },
  legend: {
    borderTopWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[4],
    paddingTop: spacing[1],
  },
  legendLabel: t("mono"),
  succeeded: {},
  // The succeeded segment takes the rounded cap only when nothing is stacked
  // on top of it.
  succeededCapped: {
    borderTopEndRadius: radii.sm,
    borderTopStartRadius: radii.sm,
  },
});
