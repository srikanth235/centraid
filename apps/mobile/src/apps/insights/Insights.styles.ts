import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  exportError: { ...t("mono"), paddingBottom: spacing[2] },
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
