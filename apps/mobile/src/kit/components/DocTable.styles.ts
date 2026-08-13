// Geometry for the always-collapsed record table (#765, spec §9/§11).

import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

/** The collapsed row is TALLER than a list row (52 vs 44): it carries two
 *  lines where the wide form carries one, and the reference grows the row
 *  rather than tightening the leading. Layout dimension, not a token. */
const COLLAPSED_ROW = 52;

export const styles = StyleSheet.create({
  caption: {
    ...t("mono"),
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  captionRow: { borderTopWidth: borders.hairline },
  more: {
    alignItems: "center",
    flexGrow: 0,
    flexShrink: 0,
    height: metrics.controlTouch,
    justifyContent: "center",
    width: metrics.controlTouch,
  },
  row: {
    alignItems: "center",
    borderTopWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: COLLAPSED_ROW,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowFirst: { borderTopWidth: 0 },
  snip: t("mono"),
  table: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginBottom: spacing[3],
    overflow: "hidden",
  },
  text: { flex: 1, minWidth: 0 },
  title: t("body"),
});
