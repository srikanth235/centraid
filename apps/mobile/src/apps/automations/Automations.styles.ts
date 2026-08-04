import { StyleSheet } from "react-native";

import { family, radii, spacing, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

// StyleSheet keys stay alphabetized (repo convention). Colour comes from the
// resolved design theme, so `makeStyles(colors)` is memoized
// per palette by the screen — no hardcoded hex beyond `#fff` on the teal pill,
// which mirrors the accent-glyph contrast used across the mobile apps.
export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addBtn: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: 1,
      justifyContent: "center",
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    addBtnText: {
      color: colors.accent,
      fontFamily: family.sansMedium,
      fontSize: 12,
    },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      gap: spacing[2],
      padding: spacing[4],
    },
    // In-flight recedes through border and label tokens, never a container
    // fade: `dim` used to sit on the Pressable and drag its bordered outline,
    // its label and its icon down as one, which is the composite the Binding
    // Layer bans. The toggle pill takes no busy treatment at all — its fill
    // already flips the moment the write lands, so a fade only guessed ahead
    // of the answer.
    busyOutline: { borderColor: colors.line },
    busyOutlineText: { color: colors.textDisabled },
    cardActions: { flexDirection: "row", marginTop: spacing[2] },
    cardHead: { alignItems: "center", flexDirection: "row", gap: spacing[3] },
    cardName: { ...t("bodyStrong"), color: colors.text, flex: 1 },
    description: { ...t("small"), color: colors.textSoft, lineHeight: 19 },
    emptyCopy: { ...t("body"), color: colors.textSoft, textAlign: "center" },
    emptyHint: { ...t("small"), color: colors.textFaint, textAlign: "center" },
    emptyTitle: { ...t("title"), color: colors.text, textAlign: "center" },
    emptyWrap: {
      alignItems: "center",
      gap: spacing[3],
      paddingTop: 72,
      paddingHorizontal: spacing[4],
    },
    gallery: { gap: spacing[3], marginTop: spacing[6] },
    galleryHead: { gap: 3 },
    gallerySubtitle: { ...t("small"), color: colors.textSoft },
    galleryTitle: { ...t("title"), color: colors.text },
    // Leading back key + title/status column, centered as one header row.
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      paddingBottom: spacing[3],
      paddingHorizontal: 18,
      paddingTop: spacing[2],
    },
    headerText: { flex: 1, minWidth: 0 },
    list: { gap: spacing[3], paddingHorizontal: 18, paddingTop: spacing[2] },
    runBtn: {
      alignItems: "center",
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      gap: spacing[2],
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    runText: {
      ...t("small"),
      color: colors.accent,
      fontFamily: family.sansMedium,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    scheduleRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    scheduleText: {
      color: colors.textFaint,
      fontFamily: family.monoMedium,
      fontSize: 11,
    },
    subtitle: { ...t("small"), color: colors.textSoft, marginTop: 3 },
    templateCard: {
      alignItems: "flex-start",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      gap: spacing[3],
      padding: spacing[4],
    },
    templateCopy: { flex: 1, gap: 5, minWidth: 0 },
    templateDesc: { ...t("small"), color: colors.textSoft, lineHeight: 18 },
    templateIcon: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderRadius: radii.md,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    templateName: { ...t("bodyStrong"), color: colors.text },
    templateTrigger: {
      color: colors.textFaint,
      fontFamily: family.monoMedium,
      fontSize: 12.5,
      textTransform: "uppercase",
    },
    title: {
      color: colors.text,
      fontFamily: family.displayRegular,
      fontSize: 28,
    },
    togglePill: {
      alignItems: "center",
      borderRadius: 999,
      justifyContent: "center",
      minWidth: 52,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    toggleText: { fontFamily: family.sansMedium, fontSize: 11 },
  });
