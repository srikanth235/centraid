// Geometry for the Devices place (#765, spec §7).
//
// The page itself is only a scroll column of kit blocks — everything with an
// opinion about type or edge lives in those blocks. What is left here is the
// column's rhythm, the docked health line's clearance, and the one dialog this
// screen owns (rename, and the typed-name confirm a last-device revocation
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
    // The column of blocks.
    body: { gap: spacing[2], paddingBottom: spacing[6] },
    // The head row carries the leave key in its leading slot beside the bar
    // (#1015, S6); `headBar` takes the rest so the title truncates against the
    // key rather than against the screen edge.
    head: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
    },
    headBar: { flex: 1, minWidth: 0 },
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
    page: { flex: 1, paddingHorizontal: pageMargin },
    // The screen ROOT, which `TopSafeArea` does not fill on its own: it
    // renders a bare `View`, so a root styled only with a colour collapses
    // to nothing and takes `page` (and every row under it) with it.
    safe: { flex: 1 },
    // The ticket token is read aloud to another machine — it is data, not
    // prose, so it takes the numeric register and wraps rather than truncates.
    ticket: { ...t("mono"), color: colors.text },
    scroll: { flex: 1 },
  });
