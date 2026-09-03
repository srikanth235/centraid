import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  actionError: { ...t("mono"), paddingBottom: spacing[2] },
  body: { gap: spacing[2], paddingBottom: spacing[6] },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  page: { flex: 1, paddingHorizontal: pageMargin },
  pause: { alignItems: "flex-end" },
  safe: { flex: 1 },
  scroll: { flex: 1 },
});
