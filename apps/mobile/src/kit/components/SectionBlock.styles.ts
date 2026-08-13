// Geometry for the section heading of an operational page (#765, spec §8
// `sectionBlock`). Colourless on purpose — the component resolves ink from
// `useTheme()` so one sheet serves light and dark.

import { StyleSheet } from "react-native";

import { borders, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  // `flex:none; white-space:nowrap` — the LABEL never shrinks and never wraps.
  // A section heading on two lines reads as a second heading.
  label: { ...t("eyebrow"), flexGrow: 0, flexShrink: 0 },
  // The count is the half that gives way: it truncates, the label does not.
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
