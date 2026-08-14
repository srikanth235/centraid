// Geometry for the panel + fact list (#765, spec §9 `panelBlock`).

import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing, t } from "../theme";

/** The quoted body's leading rule — a mark, not a border, so it keeps the
 *  2pt seam weight rather than the hairline every real edge uses. */
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
  // Fixed key column: the phone NARROWS the column (110 vs the pointer's 150)
  // rather than wrapping the key, so every value starts on the same edge.
  factKey: {
    ...t("eyebrow"),
    flexGrow: 0,
    flexShrink: 0,
    width: metrics.keyColTouch,
  },
  // The value and its own caveat, stacked: the caveat is a sentence and leaves
  // the numeric register, so it cannot share the value's Text node.
  factCell: { flex: 1, gap: spacing[1], minWidth: 0 },
  factNote: t("small"),
  factValue: {
    ...t("annotLabel"),
    // Values are numerics as often as not — tabular figures come from the
    // numeric role rather than a literal, so one ramp owns the contract.
    fontVariant: t("mono").fontVariant,
  },
  facts: { paddingTop: spacing[2] },
  figure: { gap: spacing[1] },
  figureQualifier: t("small"),
  // A headline figure is still a number: the display rung, with the numeric
  // role's tabular figures rather than a literal.
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
