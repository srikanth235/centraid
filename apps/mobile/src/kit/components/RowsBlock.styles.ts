import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

const TITLE_SEAM = 1;

export const styles = StyleSheet.create({
  action: { flexGrow: 0, flexShrink: 0 },
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    overflow: "hidden",
  },
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
  rowFirst: { borderTopWidth: 0 },
  struck: { textDecorationLine: "line-through" as const },
  sub: t("mono"),
  text: { flex: 1, gap: TITLE_SEAM, minWidth: 0 },
  title: t("body"),
});
