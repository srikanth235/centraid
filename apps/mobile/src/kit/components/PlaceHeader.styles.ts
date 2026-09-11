// Geometry for the operational page's own bar (#765, spec §11 `appAll`).

import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  // The gutter is the bar's own, like the back row above it and the body
  // below: neither room that draws this bar pads it, so without it the title
  // sat on the screen edge and the trailing verb ran off it (#1015 re-audit).
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: pageMargin,
    paddingBottom: spacing[3],
    paddingTop: spacing[2],
  },
  title: { ...t("title"), flex: 1, minWidth: 0 },
  verb: { flexGrow: 0, flexShrink: 0 },
});
