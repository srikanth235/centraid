import { StyleSheet } from "react-native";

import { borders, spacing, t, radii } from "../../kit/theme";

export const styles = StyleSheet.create({
  albumCard: { paddingBottom: spacing[3], paddingHorizontal: spacing[1] },
  albumCover: { aspectRatio: 1.35, borderRadius: radii.lg, width: "100%" },
  albumInput: {
    ...t("body"),
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginTop: spacing[4],
    padding: spacing[3],
  },
  albumTitle: { ...t("smallStrong"), marginTop: spacing[2] },
  backdrop: { flex: 1 },
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
  create: {
    alignItems: "center",
    borderRadius: radii.lg,
    marginTop: spacing[3],
    padding: spacing[3],
  },
  createText: t("control"),
  dialog: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    insetInlineEnd: spacing[5],
    insetInlineStart: spacing[5],
    padding: spacing[5],
    position: "absolute",
    top: "34%",
  },
  dialogTitle: t("title"),
  empty: { ...t("small"), paddingVertical: spacing[4] },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing[2],
  },
  headerBtn: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  icon: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  pageSection: { paddingHorizontal: spacing[1] },
  row: {
    alignItems: "center",
    borderBottomWidth: borders.hairline,
    flexDirection: "row",
    minHeight: 64,
  },
  rowCopy: { flex: 1, marginStart: spacing[3], minWidth: 0 },
  rowMeta: t("mono"),
  rowTitle: t("body"),
  section: {
    ...t("eyebrow"),
    marginBottom: spacing[1],
    marginTop: spacing[5],
  },
  title: t("title"),
});
