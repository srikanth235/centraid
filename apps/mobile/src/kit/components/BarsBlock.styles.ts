import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

export const CHART_HEIGHT = 116;
export const COLUMN_GAP = 3;

export const MAX_COLUMNS = 31;

const TIGHT_COLUMNS = 14;
const TIGHT_GAP = 1;

export function columnGap(columns: number): number {
  return columns > TIGHT_COLUMNS ? TIGHT_GAP : COLUMN_GAP;
}

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
  succeededCapped: {
    borderTopEndRadius: radii.sm,
    borderTopStartRadius: radii.sm,
  },
});
