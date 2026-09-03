import { StyleSheet } from "react-native";

import { borders, family, radii, t } from "../kit/theme";
import { resolveTheme } from "../kit/theme/resolve";

const dark = resolveTheme("dark").colors;

const WAIVED = {
  viewfinder: "#000",
} as const;

export const C = {
  bg: dark.bg,
  fieldBg: dark.bgElev,
  fieldLine: dark.lineStrong,
  text: dark.text,
  textSoft: dark.textSoft,
  textFaint: dark.textFaint,
  textGhost: dark.textGhost,
  onBrand: dark.textInv,
  danger: dark.danger,
  brand: dark.accent,
};

export const AVATAR = 52;
const SWATCH = 34;

export const PAD_TOP = 20;
export const PAD_BOTTOM = 34;
export const PAD_H = 26;
export const HERO_GAP = 18;

export const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderRadius: AVATAR / 2,
    height: AVATAR,
    justifyContent: "center",
    width: AVATAR,
  },
  avatarInitial: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  center: { alignItems: "center" },
  doneBadge: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: radii.lg,
    height: 76,
    justifyContent: "center",
    marginBottom: 22,
    width: 76,
  },
  error: {
    color: C.danger,
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 14,
  },
  fieldLabel: {
    color: C.textGhost,
    fontFamily: family.sansMedium,
    fontSize: t("control").fontSize,
    letterSpacing: 1,
    marginBottom: 9,
  },
  fieldGap: { marginTop: 20 },
  h1: {
    color: C.text,
    ...t("display"),
    letterSpacing: -0.8,
    marginBottom: 12,
  },
  h1Accent: { color: C.brand },
  hero: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: HERO_GAP,
  },
  identity: { alignItems: "center", flexDirection: "row", gap: 13 },
  identityInput: { flex: 1 },
  input: {
    backgroundColor: C.fieldBg,
    borderColor: C.fieldLine,
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    color: C.text,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    height: 52,
    paddingHorizontal: 16,
  },
  lede: {
    color: C.textFaint,
    ...t("body"),
    marginBottom: 24,
  },
  ledeStrong: { color: C.textSoft },
  note: {
    color: C.textFaint,
    ...t("small"),
    marginTop: 14,
  },
  phrase: {
    backgroundColor: C.fieldBg,
    borderColor: C.fieldLine,
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    color: C.text,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    height: 64,
    paddingHorizontal: 15,
  },
  pressed: { opacity: 0.82 },
  primary: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: 8,
    height: 52,
    justifyContent: "center",
    marginTop: 28,
  },
  primaryLabel: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
  safe: { backgroundColor: C.bg, flex: 1 },
  scanBtn: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: radii.lg,
    gap: 10,
    marginTop: 26,
    paddingVertical: 20,
  },
  scanBtnLabel: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  scanFrame: {
    aspectRatio: 1,
    backgroundColor: WAIVED.viewfinder,
    borderRadius: radii.lg,
    marginTop: 8,
    overflow: "hidden",
    width: "100%",
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: PAD_H,
    paddingTop: PAD_TOP,
    paddingBottom: PAD_BOTTOM,
  },
  swatch: {
    alignItems: "center",
    borderRadius: SWATCH / 2,
    borderWidth: 2,
    height: SWATCH,
    justifyContent: "center",
    width: SWATCH,
  },
  swatchMark: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  textBtn: {
    alignItems: "center",
    height: 48,
    justifyContent: "center",
    marginTop: 10,
  },
  textBtnLabel: {
    color: C.textFaint,
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
  topRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  wordmark: { alignItems: "center", flexDirection: "row", gap: 8 },
  wordmarkText: {
    color: C.textFaint,
    fontFamily: family.sansMedium,
    fontSize: t("control").fontSize,
    letterSpacing: 2,
  },
});
