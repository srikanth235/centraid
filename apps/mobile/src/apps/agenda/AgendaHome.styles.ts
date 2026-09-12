// Geometry for Agenda's native surfaces. Colour arrives from `useTheme` at
// the call site; nothing here names an ink.

import { StyleSheet } from "react-native";

import { pageMargin, radii, spacing, t } from "../../kit/theme";

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
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  eventMeta: { ...t("annotLabel") },
  eventTime: { ...t("mono") },
  eventTitle: { ...t("bodyStrong") },
  eventsCol: { flex: 1, gap: 6 },
  frame: { flex: 1 },
  list: { gap: 14, paddingBottom: spacing[5], paddingHorizontal: pageMargin },
  /** The day bar: which day the surface is anchored on, and the two steps
   *  either side of it. Without it there was no way to reach any day but
   *  today (#1015, audit agenda/findings#3). */
  dayBar: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: pageMargin,
    paddingVertical: spacing[2],
  },
  dayBarLabel: { ...t("bodyStrong"), flex: 1, textAlign: "center" },
  /** The month heading between two day rows. A 120-day list with no month
   *  turns September into October in silence (findings#4). */
  monthHead: { ...t("eyebrow"), paddingTop: spacing[3] },
  /** The held-write mark: a 2pt rule on the reading edge and the words beside
   *  it. Drawn inline here rather than in a shared kit file — it is two
   *  elements, and a component for it would be a dependency for nothing. */
  pendingMark: {
    borderStartWidth: 2,
    marginTop: 4,
    paddingStart: 8,
  },
  pendingText: { ...t("annotLabel") },
  /** THE DAY-CONTEXT RIBBON (#834): a costless fact about the day on a 2pt
   *  rule, in the annotation register — decoration on the day, never a card
   *  competing with a meeting. */
  ribbon: {
    ...t("annotLabel"),
    borderStartWidth: 2,
    paddingStart: 8,
  },
  /** The collapsed due shelf and its rows. 44pt targets, without exception. */
  shelfRow: {
    borderStartWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingStart: 8,
  },
  shelfText: { ...t("annotLabel") },
  shelfToggle: { justifyContent: "center", minHeight: 44 },

  /** The now line: a hairline in the attention tone with its time at the
   *  reading edge. Drawn on the Day surface only. */
  nowLine: { alignItems: "center", flexDirection: "row", gap: 6 },
  nowRule: { flex: 1, height: 1 },
  nowText: { ...t("annotLabel"), fontVariant: ["tabular-nums"] as const },
});
