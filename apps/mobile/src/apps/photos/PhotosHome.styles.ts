// Colour-taking (a factory over `ThemeColors`): what is left after the room
// took the header, the selection bar and the safe area (#1015 Wave 2) is the
// library body's two empty registers and the determinate upload meter.

import { StyleSheet } from "react-native";

import { radii, spacing, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { flex: 1 },
    bodyText: {
      ...t("body"),
      color: colors.textSoft,
      marginTop: 12,
      maxWidth: 290,
      textAlign: "center",
    },
    center: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: spacing[5],
    },
    emptyTitle: { ...t("display"), color: colors.text },
    uploadFill: { borderRadius: radii.pill, height: "100%" },
    uploadProgress: {
      gap: 5,
      paddingHorizontal: spacing[4],
      paddingVertical: 8,
    },
    uploadProgressText: { ...t("mono"), color: colors.textSoft },
    uploadTrack: {
      backgroundColor: colors.line,
      borderRadius: radii.pill,
      height: 5,
      overflow: "hidden",
    },
  });
