// Geometry for the workhorse row list (#765, spec §9 `rowsBlock`).
//
// Colourless: ink and edges come from `useTheme()` at the call site, so the
// same sheet serves both schemes and the net-toned variant is a colour swap
// rather than a second geometry.

import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, subBase, t } from "../theme";

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
  // Revoked, and still on the record: the title is ruled through while the row
  // keeps its height and its rule. The ink step comes from the theme at the
  // call site, on the leaf, never as a container opacity.
  struck: { textDecorationLine: "line-through" as const },
  sub: t("mono"),
  // `subBase.hair`, not a bare 1: the seam between a row's title and its sub
  // line is a rule inside one text stack, and the exception to the 4px scale
  // is claimed by name in the system rather than eyeballed here (#1015, R-B-6;
  // docs/decisions.md#typography-and-design-contracts).
  text: { flex: 1, gap: subBase.hair, minWidth: 0 },
  title: t("body"),
});
