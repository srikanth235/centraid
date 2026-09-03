import { StyleSheet } from "react-native";

import { borders, spacing, t, radii } from "../theme";

export const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: spacing[4],
  },
  actionText: t("control"),
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  body: { ...t("reading"), marginBottom: spacing[4] },
  eyebrow: t("eyebrow"),
  fact: {
    borderBottomWidth: borders.hairline,
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
    minHeight: 44,
    paddingVertical: spacing[2],
  },
  factFlagged: { paddingLeft: spacing[3] },
  factLabel: t("mono"),
  factValue: { ...t("mono"), marginTop: spacing[1] },
  filled: { borderColor: "transparent" },
  note: { ...t("small"), paddingHorizontal: spacing[1] },
  panel: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginBottom: spacing[4],
    padding: spacing[4],
  },
  panelTitle: {
    ...t("title"),
    marginBottom: spacing[3],
    marginTop: spacing[2],
  },
  unavailable: { ...t("small"), marginTop: spacing[3] },
});
