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
