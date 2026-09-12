// Geometry for the Devices place (#765, spec §7).
//
// The page's own frame — safe area, head row, gutter and scroll column — moved
// to `SystemPlace` in #1015 Wave 2. What is left here is the docked health
// line's clearance and the one dialog this screen owns (rename, and the typed-name confirm a last-device revocation
// needs), whose anatomy is the app's existing modal idiom
// (`apps/photos/AlbumDetail.tsx`).

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

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { backgroundColor: colors.scrim, flex: 1 },
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
    dock: { paddingBottom: spacing[3] },
    input: {
      ...t("body"),
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      minHeight: metrics.controlTouch,
      paddingHorizontal: spacing[3],
    },
    // The ticket token is read aloud to another machine — it is data, not
    // prose, so it takes the numeric register and wraps rather than truncates.
    ticket: { ...t("mono"), color: colors.text },
  });
