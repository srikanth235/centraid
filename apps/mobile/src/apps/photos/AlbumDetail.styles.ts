// One album's layout (issue #712 P18, extracted from ./AlbumDetail).
//
// THE SEAM. `AlbumDetail.tsx` is the album's BEHAVIOUR — which photographs are
// in it, which are selected, which writes the member's role permits, and what
// each refusal says. None of that is geometry. Splitting the sheet out is the
// `.styles.ts` convention this directory already keeps (PhotoLightbox,
// PhotosLibrary, PhotoEditor, FaceReview, EnrichmentConsent), and it leaves the
// screen reading as data + routes.
//
// COLOUR-TAKING, unlike PhotosLibrary's colourless sheet: several rules here
// (the destructive outline, the scrim, the dialog surface) ARE the colour
// decision, so the factory takes `ThemeColors` and the screen memoises it.

import { StyleSheet } from "react-native";

import { borders, spacing, t, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: { flexDirection: "row" },
    backdrop: { backgroundColor: colors.scrim, flex: 1 },
    blockedReason: {
      ...t("mono"),
      paddingBottom: spacing[1],
      paddingHorizontal: spacing[4],
    },
    copy: { flex: 1, marginStart: spacing[2], minWidth: 0 },
    destructive: { borderColor: colors.danger },
    disabledOutline: { borderColor: colors.line },
    destructiveText: { color: colors.danger },
    dialog: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      insetInlineEnd: spacing[5],
      insetInlineStart: spacing[5],
      padding: spacing[5],
      position: "absolute",
      top: "34%",
    },
    dialogTitle: { ...t("title"), color: colors.text },
    empty: {
      alignItems: "center",
      flex: 1,
      gap: spacing[3],
      justifyContent: "center",
      paddingHorizontal: spacing[6],
    },
    emptyBody: { ...t("small"), color: colors.textSoft, textAlign: "center" },
    emptyTitle: { ...t("display"), color: colors.text, textAlign: "center" },
    header: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: 48,
      paddingEnd: spacing[3],
      paddingStart: spacing[2],
    },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    input: {
      ...t("body"),
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      color: colors.text,
      marginTop: spacing[4],
      padding: spacing[3],
    },
    keepCopy: { flex: 1, minWidth: 0 },
    keepRow: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      marginHorizontal: spacing[4],
      minHeight: 44,
      paddingVertical: spacing[2],
    },
    keepTitle: { ...t("smallStrong"), color: colors.text },
    meta: { ...t("mono"), color: colors.textSoft },
    outlineBtn: {
      borderColor: colors.line,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    outlineBtnText: { ...t("control"), color: colors.text },
    save: { alignItems: "center", marginTop: spacing[3], padding: spacing[3] },
    saveText: { ...t("control"), color: colors.textInv },
    selectionActions: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
    },
    title: { ...t("title"), color: colors.text },
  });
