// Geometry for the workhorse row list (#765, spec §9 `rowsBlock`).
//
// Colourless: ink and edges come from `useTheme()` at the call site, so the
// same sheet serves both schemes and the net-toned variant is a colour swap
// rather than a second geometry.

import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

/** The reference's `gap: 1px` between a row's title and its sub line — a
 *  seam inside one text stack, not a rhythm step, which is why it is not on
 *  the 4px scale. */
const TITLE_SEAM = 1;

export const styles = StyleSheet.create({
  action: { flexGrow: 0, flexShrink: 0 },
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    overflow: "hidden",
  },
  // The per-row escape hatch (an outbox editor, an expansion) sits UNDER the
  // row line inside the same cell, so the divider still separates records.
  expansion: { paddingBottom: spacing[3], paddingHorizontal: spacing[3] },
  line: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: metrics.row,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  meta: { ...t("mono"), flexGrow: 0, flexShrink: 0 },
  row: { borderTopWidth: borders.hairline },
  // The first row carries no rule; the container's own edge is its top.
  rowFirst: { borderTopWidth: 0 },
  sub: t("mono"),
  text: { flex: 1, gap: TITLE_SEAM, minWidth: 0 },
  title: t("body"),
});
