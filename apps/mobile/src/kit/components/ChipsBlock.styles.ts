// Geometry for the filter/segment chip row (#765, spec §8 `chipsBlock`).
//
// The HELD PAIR is the whole point of the two label sheets: `body` → `labelOn`
// (and `annotLabel` → `annotLabelOn` in the numeric variant) change WEIGHT and
// keep size and leading, so choosing a chip cannot re-flow the row. The pill's
// height is fixed for the same reason at a coarser grain: a label that grew
// would break out of the pill rather than grow it.

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
  // The numeric variant (Analytics' 7 / 30 / 90 window): the annotation rung's
  // own held pair, plus tabular figures taken from the numeric role rather
  // than written as a literal.
  monoLabel: { ...t("annotLabel"), fontVariant: t("mono").fontVariant },
  monoLabelOn: { ...t("annotLabelOn"), fontVariant: t("mono").fontVariant },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingBottom: spacing[3],
  },
});
