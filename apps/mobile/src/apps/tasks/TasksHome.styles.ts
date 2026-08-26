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

export const makeTasksStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    empty: { alignItems: "center", padding: spacing[6] },
    emptyTitle: { ...t("title"), color: colors.text, textAlign: "center" },
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
    listContent: { paddingHorizontal: spacing[4], paddingBottom: spacing[5] },
    // Every number is tabular and bidi-isolated: without the isolate,
    // `today, 17:00` reorders under RTL and a member reads a time nobody wrote.
    num: { ...t("mono"), color: colors.textFaint },
    pane: { gap: spacing[2], padding: spacing[4] },
    pendingWords: { ...t("annotLabel"), color: colors.textFaint },
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
    title: { ...t("body"), color: colors.text, flexShrink: 1 },
    titleDone: {
      color: colors.textFaint,
      textDecorationLine: "line-through",
    },
    // The vault marker is a read-only STATUS chip, never a control colour.
    vault: { ...t("eyebrow"), color: colors.textFaint },
    verbText: { ...t("control"), color: colors.textSoft },
  });
