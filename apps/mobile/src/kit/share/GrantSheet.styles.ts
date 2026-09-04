// Geometry for the native grant sheet (#825). Colourless: every colour
// comes from `useTheme()` at the call site.

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  body: { paddingBottom: spacing[4] },
  confirmRow: { flexDirection: "row", gap: spacing[2] },
  eyebrow: t("eyebrow"),
  fixedSubject: t("bodyStrong"),
  footer: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  note: t("small"),
  pill: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  pillRow: { flexDirection: "row", gap: spacing[2] },
  reachState: t("annotLabelOn"),
  ticket: { gap: spacing[2], marginTop: spacing[2] },
  ticketCode: {
    ...t("mono"),
    borderRadius: radii.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
  },
  reading: t("reading"),
  row: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[3],
    justifyContent: "space-between",
    marginBottom: spacing[2],
    minHeight: 58,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowCopy: { flex: 1, minWidth: 0 },
  safe: { flex: 1 },
  section: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  shareButton: {
    alignItems: "center",
    borderRadius: radii.md,
    justifyContent: "center",
    minHeight: 46,
  },
  title: t("title"),
});
