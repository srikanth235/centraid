import { StyleSheet } from "react-native";

import { radii, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  body: { flex: 1 },
  dateCol: {
    alignItems: "center",
    borderRadius: radii.md,
    paddingVertical: 6,
    width: 40,
  },
  dateNum: { ...t("title") },
  dayRow: { borderTopWidth: 1, flexDirection: "row", gap: 12, paddingTop: 10 },
  empty: { ...t("body"), padding: 20, textAlign: "center" },
  eventCard: {
    borderRadius: radii.md,
    borderStartWidth: 2,
    gap: 3,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  eventMeta: { ...t("annotLabel") },
  eventTime: { ...t("mono") },
  eventTitle: { ...t("bodyStrong") },
  eventsCol: { flex: 1, gap: 6 },
  frame: { flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  headerActions: { flexDirection: "row", gap: 14 },
  headerCopy: { flex: 1 },
  list: { gap: 14, paddingBottom: 24, paddingHorizontal: 18 },
  pendingMark: {
    borderStartWidth: 2,
    marginTop: 4,
    paddingStart: 8,
  },
  pendingText: { ...t("annotLabel") },
  search: {
    alignItems: "center",
    borderRadius: radii.md,
    flexDirection: "row",
    gap: 8,
    marginHorizontal: 18,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  searchInput: { ...t("body"), flex: 1 },
  subtitle: { ...t("control") },
  title: { ...t("title") },
  ribbon: {
    ...t("annotLabel"),
    borderStartWidth: 2,
    paddingStart: 8,
  },
  shelfRow: {
    borderStartWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingStart: 8,
  },
  shelfText: { ...t("annotLabel") },
  shelfToggle: { justifyContent: "center", minHeight: 44 },

  nowLine: { alignItems: "center", flexDirection: "row", gap: 6 },
  nowRule: { flex: 1, height: 1 },
  nowText: { ...t("annotLabel"), fontVariant: ["tabular-nums"] as const },
});
