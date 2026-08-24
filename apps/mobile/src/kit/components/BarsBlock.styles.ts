// Geometry for the runs chart (#765, spec §9/§11 mobile branch).
//
// Plain Views, no SVG: the chart is ten rectangles and two rules, and a vector
// runtime for that is a dependency the screen would carry for a gradient it is
// not allowed to draw anyway (`succeeded` is tertiary INK, `failed` is `net`,
// and nothing here is chromatic beyond that one segment).

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

/** The phone's chart geometry, from the reference's mobile branch: 116pt tall
 *  (vs 148 under a pointer) and a 3pt gutter between columns (vs 5). Layout
 *  dimensions; they are not tokens because no second consumer exists. */
export const CHART_HEIGHT = 116;
export const COLUMN_GAP = 3;

/**
 * The most columns this plot can carry (#775).
 *
 * A GUARD, not a fold: this block never samples a window down to fit, because
 * a single expensive day averaged into a three-day smear is invisible to the
 * screen. The caller folds the window (`dayFold`) and this is the ceiling it
 * folds to — one column per day for every window up to a month, on a 390pt
 * screen at a 1pt gutter.
 */
export const MAX_COLUMNS = 31;

/** Columns past this many trade the gutter for plot rather than dropping days. */
const TIGHT_COLUMNS = 14;
const TIGHT_GAP = 1;

/** The gutter for a given column count — 3pt while the columns are few, 1pt
 *  once they are not, because thirty 3pt gutters are a quarter of the plot. */
export function columnGap(columns: number): number {
  return columns > TIGHT_COLUMNS ? TIGHT_GAP : COLUMN_GAP;
}

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
  // The peak line: a sentence, not a value, so it leaves the numeric register.
  note: t("small"),
  succeeded: {},
  // The succeeded segment takes the rounded cap only when nothing is stacked
  // on top of it.
  succeededCapped: {
    borderTopEndRadius: radii.sm,
    borderTopStartRadius: radii.sm,
  },
});
