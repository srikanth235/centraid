// Geometry and type for the People shelf's empty state. COLOURLESS on purpose,
// like PhotosLibrary.styles.ts: every colour comes from `useTheme()` at the
// call site, so one sheet serves light and dark.

import { StyleSheet } from "react-native";

import { radii, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  action: {
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing[3],
  },
  actionLabel: t("control"),
  block: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  line: t("small"),
  reason: t("small"),
  status: t("small"),
});
