// Palette and stylesheet for the first-run onboarding flow (screens/Onboarding).
// Split out for the same reason onboarding-art.tsx is: the flow file has to stay
// under the repo file-size limit, and a StyleSheet has no logic worth keeping
// next to the steps it dresses.
//
// Onboarding is always dark, independent of the OS theme — Settings' own
// ColorSwatchRow is the surface that follows the OS scheme. "Dark-fixed" means
// we pin the *scheme*, not that we opt out of the token contract (#686): the
// palette below is the resolved dark theme, so onboarding drifts with the
// design system instead of against it.

import { StyleSheet } from "react-native";

import { borders, family } from "../kit/theme";
// Straight from the pure resolver, not the theme barrel: this runs at module
// scope, and the barrel drags in React/RN-only surface that screens' tests mock.
import { resolveTheme } from "../kit/theme/resolve";

const dark = resolveTheme("dark").colors;

// #686 waiver: the one value the token contract has no answer for.
// `viewfinder` must be true black — it is the hole the camera preview renders
// into, and any tinted ground would show as a halo around the video frame.
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
  /** Ink that sits on `brand` / on a profile swatch. */
  onBrand: dark.textInv,
  danger: dark.danger,
  brand: dark.accent,
};

export const AVATAR = 52;
const SWATCH = 34;

// Named because the flow's hero-fitting arithmetic has to subtract exactly what
// the layout spends (see Onboarding). Keeping the numbers here means the
// stylesheet and that arithmetic can never drift apart.
/** `styles.scroll` padding. */
export const PAD_TOP = 20;
export const PAD_BOTTOM = 34;
export const PAD_H = 26;
/** `styles.hero` paddingVertical — counted on both sides by the caller. */
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
    fontSize: 19,
  },
  center: { alignItems: "center" },
  doneBadge: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: 38,
    height: 76,
    justifyContent: "center",
    marginBottom: 22,
    width: 76,
  },
  error: {
    color: C.danger,
    fontFamily: family.sansRegular,
    fontSize: 13,
    marginTop: 14,
  },
  fieldLabel: {
    color: C.textGhost,
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 9,
  },
  fieldGap: { marginTop: 20 },
  h1: {
    color: C.text,
    fontFamily: family.sansMedium,
    fontSize: 31,
    letterSpacing: -0.8,
    lineHeight: 37,
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
    borderRadius: 13,
    borderWidth: borders.hairline,
    color: C.text,
    fontFamily: family.sansRegular,
    fontSize: 16,
    height: 52,
    paddingHorizontal: 16,
  },
  lede: {
    color: C.textFaint,
    fontFamily: family.sansRegular,
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 24,
  },
  ledeStrong: { color: C.textSoft },
  note: {
    color: C.textFaint,
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
  },
  phrase: {
    backgroundColor: C.fieldBg,
    borderColor: C.fieldLine,
    borderRadius: 14,
    borderWidth: borders.hairline,
    color: C.text,
    fontFamily: family.monoRegular,
    fontSize: 15,
    lineHeight: 26,
    minHeight: 120,
    padding: 15,
  },
  pressed: { opacity: 0.82 },
  primary: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    height: 52,
    justifyContent: "center",
    marginTop: 28,
  },
  primaryLabel: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: 16,
  },
  safe: { backgroundColor: C.bg, flex: 1 },
  /** The pairing step's primary action — deliberately taller and heavier than
   *  `primary`, because it is the way in rather than one option among two. */
  scanBtn: {
    alignItems: "center",
    backgroundColor: C.brand,
    borderRadius: 18,
    gap: 10,
    marginTop: 26,
    paddingVertical: 20,
  },
  scanBtnLabel: {
    color: C.onBrand,
    fontFamily: family.sansMedium,
    fontSize: 17,
  },
  scanFrame: {
    aspectRatio: 1,
    backgroundColor: WAIVED.viewfinder,
    borderRadius: 22,
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
  swatchMark: { color: C.onBrand, fontFamily: family.sansMedium, fontSize: 14 },
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
    fontSize: 15,
  },
  topRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  wordmark: { alignItems: "center", flexDirection: "row", gap: 8 },
  wordmarkText: {
    color: C.textFaint,
    fontFamily: family.monoMedium,
    fontSize: 11,
    letterSpacing: 2,
  },
});
