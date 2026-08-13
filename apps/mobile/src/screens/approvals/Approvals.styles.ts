// Frame geometry for the Notifications place (#765). The blocks bring their
// own sheets; what is left here is the page's margins, its head row, the line
// that reports a failed action, and the two in-row controls the panel cannot
// express (the edit form and the always-allow toggle).
//
// Colourless by the kit's convention: ink resolves at the call site from
// `useTheme()`, so one sheet serves both schemes.

import { StyleSheet } from "react-native";

import {
  borders,
  metrics,
  pageMargin,
  radii,
  spacing,
  t,
} from "../../kit/theme";

/** Four lines of the reading rung — enough of a body to judge it, without a
 *  scroll view inside a scroll view. */
const INPUT_TALL = 104;

export const styles = StyleSheet.create({
  // The failed-action line sits under the head, above the blocks, because it
  // is about the tap that just happened — not about the page's health, which
  // is the standing line's job at the foot.
  actionError: { ...t("mono"), paddingBottom: spacing[2] },
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  /** A row expansion's own verbs (Approve / Deny on a parked act). */
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingTop: spacing[2],
  },
  /** What was actually asked, quoted verbatim under the row that asks it. */
  detailText: t("mono"),
  /** Matches `PanelBlock`'s fact key, so a form label and a panel key read as
   *  the same object at the same rung. */
  factKey: t("eyebrow"),
  field: { gap: spacing[1] },
  form: { gap: spacing[3], paddingTop: spacing[2] },
  formActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  input: {
    ...t("body"),
    borderRadius: radii.sm,
    borderWidth: borders.hairline,
    minHeight: metrics.controlTouch,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  inputTall: { minHeight: INPUT_TALL, textAlignVertical: "top" },
  page: { flex: 1 },
  safe: { flex: 1 },
  toggleRow: { alignItems: "flex-start", paddingTop: spacing[1] },
});
