import { StyleSheet } from "react-native";

import {
  borders,
  metrics,
  pageMargin,
  radii,
  spacing,
  t,
} from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

const HOME_KEY_CLEARANCE = 54 + 8;

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { backgroundColor: colors.scrim, flex: 1 },
    body: { gap: spacing[2], paddingBottom: spacing[6] },
    dialog: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: spacing[3],
      insetInlineEnd: pageMargin,
      insetInlineStart: pageMargin,
      padding: spacing[4],
      position: "absolute",
      top: "28%",
    },
    dialogActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "flex-end",
    },
    dialogAsk: { ...t("body"), color: colors.textSoft },
    dialogTitle: { ...t("title"), color: colors.text },
    dock: { paddingBottom: HOME_KEY_CLEARANCE },
    input: {
      ...t("body"),
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: metrics.controlTouch,
      paddingHorizontal: spacing[3],
    },
    page: { flex: 1, paddingHorizontal: pageMargin },
    safe: { flex: 1 },
    ticket: { ...t("mono"), color: colors.text },
    scroll: { flex: 1 },
  });
