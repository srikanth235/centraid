// The drive list's stylesheet, in its own module for the same reason every
// other screen's is: a 100-line style object between the component and its
// helpers is the thing that pushed `DriveList.tsx` past the file-size limit,
// and it is the part of the file nobody reads while following the logic.

import { StyleSheet } from "react-native";

import { borders, radii, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bulkBar: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 4,
      marginTop: 8,
      minHeight: 48,
      paddingHorizontal: 18,
    },
    bulkCount: { ...t("mono"), color: colors.textSoft, flex: 1 },
    bulkVerb: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 8,
    },
    bulkVerbLabel: { ...t("control"), color: colors.text },
    bulkVerbNet: { color: colors.net },
    bulkVerbOff: { color: colors.textFaint },
    caption: {
      ...t("small"),
      color: colors.textFaint,
      paddingHorizontal: 18,
      paddingTop: 8,
    },
    container: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flex: 1,
      marginHorizontal: 18,
      overflow: "hidden",
    },
    containerEmbedded: { flex: 0 },
    frame: { flex: 1 },
    frameEmbedded: { flex: 0 },
    primaryButton: {
      alignItems: "center",
      borderRadius: radii.md,
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    primaryLabel: { ...t("control") },
    quietButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 10,
    },
    quietLabel: { ...t("control"), color: colors.textSoft },
    readOnly: {
      ...t("small"),
      color: colors.textSoft,
      paddingBottom: 8,
      paddingHorizontal: 18,
    },
    renameActions: {
      flexDirection: "row",
      gap: 8,
      justifyContent: "flex-end",
    },
    renameField: {
      ...t("body"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: 44,
      paddingHorizontal: 12,
    },
    renamePanel: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      bottom: 0,
      gap: 8,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      padding: 16,
      position: "absolute",
    },
    renameTitle: { ...t("title"), color: colors.text },
    scrim: { ...StyleSheet.absoluteFill },
    status: {
      ...t("mono"),
      color: colors.textFaint,
      paddingBottom: 4,
      paddingHorizontal: 18,
      paddingTop: 6,
    },
  });
