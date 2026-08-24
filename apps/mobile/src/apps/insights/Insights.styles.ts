// Frame geometry for the Analytics place (#765). The blocks bring their own
// sheets; what is left here is the page's margins, its head row, and the one
// line that reports a failed export.
//
// Colourless by the kit's convention: ink resolves at the call site from
// `useTheme()`, so one sheet serves both schemes. The page is blocks, and a
// block owns its own geometry — there is no card, KPI-grid, meter, sparkline
// or panel family here.

import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  // The failed-export line sits under the head, above the blocks, because it
  // is about the tap that just happened — not about the page's health, which
  // is the standing line's job at the foot.
  exportError: { ...t("mono"), paddingBottom: spacing[2] },
  // The leading "back to your apps" key beside the page's own bar. The
  // floating variant would sit exactly where the standing health line is.
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  page: { flex: 1 },
  safe: { flex: 1 },
});
