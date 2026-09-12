// Geometry and type for Face review. COLOURLESS on purpose, same as
// PeopleEmptyState.styles.ts — every colour comes from `useTheme()` at the
// call site, so one sheet serves light and dark.
import { StyleSheet } from "react-native";

import { borders, spacing, t, radii } from "../../kit/theme";

export const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: spacing[4],
  },
  actionText: t("control"),
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  body: { ...t("reading"), marginBottom: spacing[4] },
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
  count: {
    ...t("mono"),
    paddingHorizontal: spacing[3],
    paddingTop: spacing[2],
  },
  cropImg: { position: "absolute" },
  eyebrow: t("eyebrow"),
  fact: {
    borderBottomWidth: borders.hairline,
    minHeight: 44,
    paddingVertical: spacing[2],
  },
  factLabel: t("mono"),
  factValue: { ...t("mono"), marginTop: spacing[1] },
  filled: { borderColor: "transparent" },
  note: { ...t("small"), paddingHorizontal: spacing[1] },
  panel: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginBottom: spacing[4],
    padding: spacing[4],
  },
  panelTitle: {
    ...t("title"),
    marginBottom: spacing[3],
    marginTop: spacing[2],
  },
  picker: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[2],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: 56,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowLabel: t("smallStrong"),
  rows: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginBottom: spacing[4],
    overflow: "hidden",
  },
  rowSub: { ...t("mono"), marginTop: 2 },
  rowText: { flex: 1 },
  status: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[3],
  },
  tile: { borderRadius: radii.lg, overflow: "hidden" },
  tileImg: { height: "100%", width: "100%" },
  tileNote: {
    ...t("mono"),
    bottom: 4,
    left: 4,
    position: "absolute",
    right: 4,
  },
  tiles: { flexDirection: "row", gap: spacing[2], marginBottom: spacing[4] },
  unavailable: { ...t("small"), marginTop: spacing[3] },
  wroteNote: { ...t("small"), marginTop: spacing[2] },
});
