// Geometry for the operational page's own bar (#765, spec §11 `appAll`).

import { StyleSheet } from "react-native";

import { spacing, t } from "../theme";

export const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingBottom: spacing[3],
    paddingTop: spacing[2],
  },
  title: { ...t("title"), flex: 1, minWidth: 0 },
  verb: { flexGrow: 0, flexShrink: 0 },
});
