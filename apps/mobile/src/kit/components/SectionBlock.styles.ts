import { StyleSheet } from "react-native";

import { borders, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  label: { ...t("eyebrow"), flexGrow: 0, flexShrink: 0 },
  meta: { ...t("mono"), flexShrink: 1, minWidth: 0 },
  row: {
    alignItems: "baseline",
    borderTopWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[3],
    marginTop: spacing[3],
    paddingBottom: spacing[2],
    paddingTop: spacing[4],
  },
});
