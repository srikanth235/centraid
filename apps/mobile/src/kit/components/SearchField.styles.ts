// Geometry for the one search field (#1015, S4).
//
// The gutter is the field's own — every caller had been wrapping it in a view
// with a hand-typed inset, and the eight fields the audit found disagreed by
// up to 6pt. Colourless, like every kit sheet: ink resolves at the call site.

import { StyleSheet } from "react-native";

import { borders, pageMargin, radii, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  clear: {
    alignItems: "center",
    // 44 wide as well as tall: a clear button is the one control a member
    // reaches for while looking at the results, not at the field.
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  count: {
    ...t("mono"),
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
  },
  field: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[2],
    minHeight: 44,
    paddingLeft: spacing[3],
  },
  input: { ...t("body"), flex: 1, minWidth: 0, paddingVertical: spacing[2] },
  row: { paddingHorizontal: pageMargin, paddingVertical: spacing[2] },
});
