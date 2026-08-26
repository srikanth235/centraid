// Runs-chart geometry (#765, spec §9/§11 mobile branch). Plain Views, no SVG.

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

export const CHART_HEIGHT = 116;
export const COLUMN_GAP = 3;

/**
 * Most columns this plot carries (#775). A GUARD, not a fold: never sample a
 * window to fit — an expensive day averaged into a smear is invisible.
 */
export const MAX_COLUMNS = 31;

/** Past this: 1pt gutter instead of dropping days. */
const TIGHT_COLUMNS = 14;
const TIGHT_GAP = 1;

export function columnGap(columns: number): number {
  return columns > TIGHT_COLUMNS ? TIGHT_GAP : COLUMN_GAP;
}

/** Seam so the stack reads as two facts, not a gradient. */
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
  note: t("small"),
  succeeded: {},
  // Rounded cap only when nothing is stacked on top.
  succeededCapped: {
    borderTopEndRadius: radii.sm,
    borderTopStartRadius: radii.sm,
  },
});
