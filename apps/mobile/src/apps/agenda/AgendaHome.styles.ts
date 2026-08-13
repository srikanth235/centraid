import { StyleSheet } from "react-native";

import { family, radii, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  calendarChip: {
    alignItems: "center",
    borderRadius: radii.pill,
    flexDirection: "row",
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 10,
  },
  calendarDot: { borderRadius: radii.sm, height: 8, width: 8 },
  calendarScroll: { flexGrow: 0, height: 48 },
  calendars: { gap: 8, paddingHorizontal: 18, paddingVertical: 9 },
  calendarText: {
    fontFamily: family.sansMedium,
    fontSize: t("control").fontSize,
  },
  create: {
    alignItems: "center",
    borderRadius: radii.lg,
    marginTop: 12,
    padding: 12,
  },
  // The 34px date column — day-of-month (mono, tabular) over day-of-week
  // (eyebrow caps). Width is fixed per the Binding Layer reference so every
  // row's events column starts at the same inset regardless of digit count.
  dateCol: {
    alignItems: "center",
    borderRadius: radii.md,
    paddingTop: 4,
    paddingBottom: 6,
    width: 34,
  },
  dateNum: { fontSize: t("body").fontSize },
  dayRow: {
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 16,
    paddingVertical: 12,
  },
  dialog: {
    borderRadius: radii.lg,
    left: 28,
    padding: 20,
    position: "absolute",
    right: 28,
    top: "31%",
  },
  dialogMeta: {
    ...t("small"),
    marginTop: 6,
  },
  dialogTitle: {
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  empty: {
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    padding: 40,
    textAlign: "center",
  },
  // One mini-card per event: title above time (never beside it), a 2px
  // leading accent rule standing in for the identity hue the row itself
  // never carries.
  eventCard: {
    borderStartWidth: 2,
    gap: 2,
    paddingStart: 10,
  },
  eventTitle: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  eventsCol: { flex: 1, gap: 10, minWidth: 0 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 18,
  },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 22 },
  headerCopy: { flex: 1, marginLeft: 12 },
  input: {
    borderRadius: radii.lg,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    marginTop: 16,
    padding: 12,
  },
  list: { paddingBottom: 40, paddingHorizontal: 18 },
  nav: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  navArrows: { flexDirection: "row", gap: 10 },
  rangeTitle: {
    flex: 1,
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
    textAlign: "right",
  },
  safe: { flex: 1 },
  search: {
    alignItems: "center",
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
    marginHorizontal: 18,
    paddingHorizontal: 11,
  },
  searchInput: {
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    paddingVertical: 10,
  },
  segment: {
    borderRadius: radii.lg,
    flexDirection: "row",
    marginHorizontal: 18,
    padding: 3,
  },
  segmentItem: {
    alignItems: "center",
    borderRadius: radii.md,
    flex: 1,
    paddingVertical: 7,
  },
  segmentText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  startPreset: {
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  startPresets: { flexDirection: "row", gap: 8, marginTop: 12 },
  startPresetText: {
    fontFamily: family.sansMedium,
    fontSize: t("control").fontSize,
  },
  subtitle: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: 2,
  },
  today: {
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  todayText: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  title: { fontFamily: family.sansMedium, fontSize: t("title").fontSize },
  week: { gap: 8, padding: 14, paddingHorizontal: 18 },
  weekCount: { marginTop: 7 },
  weekDay: {
    alignItems: "center",
    borderRadius: radii.lg,
    padding: 10,
    width: 52,
  },
  weekNumber: { fontSize: t("reading").fontSize, marginTop: 5 },
});
