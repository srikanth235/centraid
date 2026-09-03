import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

const QUOTE_RULE = 2;

export const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  body: t("reading"),
  eyebrow: t("eyebrow"),
  fact: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    paddingVertical: spacing[2],
  },
  factKey: {
    ...t("eyebrow"),
    flexGrow: 0,
    flexShrink: 0,
    width: metrics.keyColTouch,
  },
  factCell: { flex: 1, gap: spacing[1], minWidth: 0 },
  factNote: t("small"),
  factValue: {
    ...t("annotLabel"),
    fontVariant: t("mono").fontVariant,
  },
  facts: { paddingTop: spacing[2] },
  figure: { gap: spacing[1] },
  figureQualifier: t("small"),
  figureValue: { ...t("display"), fontVariant: t("mono").fontVariant },
  panel: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    gap: spacing[2],
    padding: spacing[4],
  },
  quote: { paddingInlineStart: spacing[3], borderStartWidth: QUOTE_RULE },
  title: t("title"),
});
