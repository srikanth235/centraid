// Colour-taking (a factory over `ThemeColors`): the head's hairline and the
// scroll region's ground are colour decisions.

import { StyleSheet } from "react-native";

import {
  BAND_BORDER,
  BAND_HEIGHT,
  BAND_INSET,
  BAND_RADIUS,
  BAND_TOP_GAP,
} from "../../kit/band-surface";
import { family, pageMargin, t, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { BAND_CAPSULE } from "./photos-band";

/** Same gap as the band's own two plates (`PhotosBand.tsx`'s `PLATE_GAP`). */
const SELECTION_PLATE_GAP = 8;

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
      paddingHorizontal: 28,
    },
    emptyTitle: { ...t("display"), color: colors.text },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      // 56px (handoff `appBarStyle` min-height).
      minHeight: 56,
      paddingHorizontal: pageMargin,
    },
    headerActions: { flexDirection: "row" },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    safe: { flex: 1 },
    // Selection bar (#712): same plate anatomy as `PhotosBand.tsx` so the
    // thing that replaces the band reads as the same furniture.
    selectionBarRow: {
      alignItems: "stretch",
      backgroundColor: "transparent",
      flexDirection: "row",
      gap: SELECTION_PLATE_GAP,
      minHeight: BAND_HEIGHT,
      paddingHorizontal: BAND_INSET,
      paddingTop: BAND_TOP_GAP,
    },
    selectionChip: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      justifyContent: "center",
      width: BAND_CAPSULE.size,
    },
    selectionCountPlate: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flex: 1,
      justifyContent: "center",
    },
    selectionCountText: {
      ...t("control"),
      color: colors.text,
      fontFamily: family.sansMedium,
    },
    // `header`'s `paddingHorizontal: pageMargin` is the margin; do not add
    // another token on the title.
    title: { ...t("title"), color: colors.text },
    uploadFill: { borderRadius: radii.pill, height: "100%" },
    uploadProgress: { gap: 5, paddingHorizontal: 16, paddingVertical: 8 },
    uploadProgressText: { ...t("mono"), color: colors.textSoft },
    uploadTrack: {
      backgroundColor: colors.line,
      borderRadius: radii.pill,
      height: 5,
      overflow: "hidden",
    },
  });
