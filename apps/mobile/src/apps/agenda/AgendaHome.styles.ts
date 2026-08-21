// Geometry for Agenda's native surfaces. Colour arrives from `useTheme` at
// the call site; nothing here names an ink.

import { StyleSheet } from "react-native";

import { radii, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  body: { flex: 1 },
  /** The day rail's date column — the row's identity, not a separate header
   *  interleaved with the events under it. */
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
  /** The held-write mark: a 2pt rule on the reading edge and the words beside
   *  it. Drawn inline here rather than in a shared kit file — it is two
   *  elements, and a component for it would be a dependency for nothing. */
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
  /** The now line: a hairline in the attention tone with its time at the
   *  reading edge. Drawn on the Day surface only. */
  nowLine: { alignItems: "center", flexDirection: "row", gap: 6 },
  nowRule: { flex: 1, height: 1 },
  nowText: { ...t("annotLabel"), fontVariant: ["tabular-nums"] as const },
});
