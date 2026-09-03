import { StyleSheet } from "react-native";

import { spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing[2],
  },
  headerBtn: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  safe: { flex: 1 },
  status: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[3],
  },
  title: t("title"),
});
