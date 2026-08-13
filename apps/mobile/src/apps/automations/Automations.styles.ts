// Frame geometry for the Automations place (#765). The kit blocks bring their
// own sheets; what is left here is the page's margins, its head row, the one
// line that reports a failed action, and the clearance the standing health
// line needs at the foot.
//
// Colourless by the kit's convention: ink resolves at the call site from
// `useTheme()`, so one sheet serves both schemes.

import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  // The failed-action line sits under the head, above the blocks, because it
  // is about the tap that just happened — not about the page's health, which
  // is the standing line's job at the foot.
  actionError: { ...t("mono"), paddingBottom: spacing[2] },
  body: { gap: spacing[2], paddingBottom: spacing[6] },
  // The leading "back to your apps" key beside the page's own bar. The
  // floating variant would sit exactly where the standing health line is.
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  page: { flex: 1, paddingHorizontal: pageMargin },
  // A row's expansion holds one quiet control, pushed to the trailing edge so
  // it reads as belonging to the row above it rather than starting a new one.
  pause: { alignItems: "flex-end" },
  safe: { flex: 1 },
  scroll: { flex: 1 },
});
