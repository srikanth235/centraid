// Tasks' native styles (Tasks spec §5; #834). Values come from the design
// boundary (`kit/theme`) and nothing else — no hex, no literal rule weight, no
// font size of its own.

import { StyleSheet } from "react-native";

import { borders, radii, spacing, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The touch floor, without exception (§7). */
const TOUCH = 44;
/** The pending rule's weight — 2px, the one deliberate exception to the
 *  hairline, because it is a MARK rather than a boundary. */
const PENDING_RULE = 2;

export type TasksStyles = ReturnType<typeof makeTasksStyles>;

export const makeTasksStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    back: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[1],
      minHeight: TOUCH,
      paddingEnd: spacing[2],
    },
    backLabel: { ...t("control"), color: colors.text },
    box: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      borderWidth: 1,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    capture: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    captureField: {
      ...t("reading"),
      color: colors.text,
      flex: 1,
      minHeight: TOUCH,
    },
    // The anchor's two cards: the SELECTED one takes the raised surface and an
    // ink border — no hue, because a control never carries the app's.
    card: {
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flex: 1,
      gap: spacing[1],
      minHeight: TOUCH,
      padding: spacing[3],
    },
    cardBody: { ...t("annotLabel"), color: colors.textSoft },
    cardHead: { ...t("bodyStrong"), color: colors.text },
    cardOn: { backgroundColor: colors.bgElev, borderColor: colors.lineStrong },
    cards: { flexDirection: "row", gap: spacing[2] },
    chip: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: TOUCH,
      paddingHorizontal: spacing[3],
    },
    chipOn: { backgroundColor: colors.bgSel, borderColor: colors.lineStrong },
    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
    chipText: { ...t("control"), color: colors.textSoft },
    chipTextOn: { color: colors.text },
    detailNote: {
      ...t("body"),
      color: colors.textSoft,
      minHeight: TOUCH,
      paddingVertical: spacing[2],
    },
    detailTitle: {
      ...t("title"),
      color: colors.text,
      flex: 1,
      minHeight: TOUCH,
    },
    detailTop: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[4],
    },
    empty: { alignItems: "center", padding: spacing[6] },
    emptyTitle: { ...t("title"), color: colors.text, textAlign: "center" },
    fieldBody: { flex: 1, gap: spacing[2] },
    fieldKey: { ...t("eyebrow"), color: colors.textFaint, width: 88 },
    fieldNote: { ...t("annotLabel"), color: colors.textFaint },
    fieldRow: {
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: TOUCH,
      paddingVertical: spacing[2],
    },
    fieldValue: { ...t("body"), color: colors.text },
    // Delete is the ONE outlined `net` control in this room; Release destroys
    // nothing and stays a plain secondary.
    foot: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingVertical: spacing[4],
    },
    footNet: { borderColor: colors.net },
    footNetText: { color: colors.net },
    footVerb: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: TOUCH,
      paddingHorizontal: spacing[4],
    },
    groupHead: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: spacing[2],
      paddingTop: spacing[4],
      paddingBottom: spacing[2],
    },
    groupLabel: { ...t("smallStrong"), color: colors.text },
    // OVERDUE IS THE ATTENTION TONE, NEVER RED. `net` is reserved for
    // destructive controls and is outlined even there.
    groupLabelAttention: { color: colors.seam },
    headVerb: {
      justifyContent: "center",
      marginStart: "auto",
      minHeight: TOUCH,
      paddingHorizontal: spacing[2],
    },
    lead: { ...t("body"), color: colors.textSoft },
    listContent: { paddingHorizontal: spacing[4], paddingBottom: spacing[5] },
    // Every number is tabular and bidi-isolated: without the isolate,
    // `today, 17:00` reorders under RTL and a member reads a time nobody wrote.
    num: { ...t("mono"), color: colors.textFaint },
    pane: { gap: spacing[2], padding: spacing[4] },
    pendingWords: { ...t("annotLabel"), color: colors.textFaint },
    placeHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: TOUCH,
      paddingHorizontal: spacing[4],
    },
    placeTitle: { ...t("title"), color: colors.text, flex: 1 },
    readOnly: {
      ...t("annotLabel"),
      color: colors.textSoft,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    primary: {
      alignItems: "center",
      backgroundColor: colors.accentFill,
      borderRadius: radii.md,
      justifyContent: "center",
      minHeight: TOUCH,
      paddingHorizontal: spacing[4],
    },
    // A filled control that cannot be pressed stops being filled.
    primaryOff: { backgroundColor: colors.bgSunken },
    primaryText: { ...t("control"), color: colors.onAccent },
    projectRow: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      minHeight: TOUCH,
    },
    rowChild: { paddingStart: spacing[6] },
    rowMain: { flex: 1, justifyContent: "center", minHeight: TOUCH },
    rowPending: {
      borderStartColor: colors.textFaint,
      borderStartWidth: PENDING_RULE,
      paddingStart: spacing[2],
    },
    rowPicked: { backgroundColor: colors.bgSel },
    rowWrap: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: TOUCH,
    },
    searchField: {
      ...t("reading"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: TOUCH,
      paddingHorizontal: spacing[3],
    },
    title: { ...t("body"), color: colors.text, flexShrink: 1 },
    titleDone: {
      color: colors.textFaint,
      textDecorationLine: "line-through",
    },
    // The vault marker is a read-only STATUS chip, never a control colour.
    vault: { ...t("eyebrow"), color: colors.textFaint },
    verbText: { ...t("control"), color: colors.textSoft },
  });
