// Typed native lowering of the product grammar.
//
// This module is deliberately independent of CSS.  Every value returned here
// is concrete and ready for React Native; there is no var(), calc(),
// color-mix(), stylesheet parser, or runtime override layer in the mobile
// path.

import { spacing } from "./density";
import { palette } from "./palette";
import { radii } from "./radii";
import { assertNativeColorRoleContract } from "./roles";
import { ACCENT_PALETTE } from "./themes";
import type { AccentKey } from "./themes";
import { nativeTypeStyle, typeForProfile } from "./typography";
import type { TypeKey } from "./typography";

export type NativeScheme = "dark" | "light";

export interface NativeColors {
  accent: string;
  accentDeep: string;
  accentFill: string;
  accentDeepHover: string;
  accentLight: string;
  accentSoft: string;
  accentText: string;
  appIdentityText: string;
  bg: string;
  bgChrome: string;
  bgElev: string;
  bgHover: string;
  bgPress: string;
  bgSel: string;
  bgSunken: string;
  danger: string;
  line: string;
  lineStrong: string;
  lineSel: string;
  onAccent: string;
  focusRingColor: string;
  scrim: string;
  shadowLg: string;
  shadowMd: string;
  shadowSm: string;
  success: string;
  text: string;
  textFaint: string;
  textGhost: string;
  textDisabled: string;
  textInv: string;
  textSoft: string;
  warning: string;
  [key: `c${string}`]: string;
}

export interface NativeTypeStyle {
  family: Type["family"];
  fontSize: number;
  lineHeight: number;
  weight: Type["weight"];
}

export type NativeTypeKey = Exclude<TypeKey, "hero">;

type Type = (typeof import("./typography").type)[TypeKey];

export interface NativeTheme {
  scheme: NativeScheme;
  colors: NativeColors;
  radii: typeof radii;
  spacing: typeof spacing;
  type: Record<NativeTypeKey, NativeTypeStyle>;
  targetMin: { coarse: number; fine: number };
  durations: { one: number; two: number };
}

const shared = {
  danger: "#B6322B",
  success: "#267044",
  warning: "#8C5E17",
};

function iconPalette(): Record<`c${string}`, string> {
  return Object.fromEntries(
    Object.entries(palette).map(([key, value]) => [
      `c${key.slice(0, 1).toUpperCase()}${key.slice(1)}`,
      value,
    ])
  ) as Record<`c${string}`, string>;
}

function rgbaHex(hex: string, alpha: number): string {
  const digits = hex.slice(1);
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(digits.slice(offset, offset + 2), 16)
  );
  return `rgba(${channels.join(",")},${alpha.toString().replace(/^0(?=\.)/u, "")})`;
}

function mixHex(from: string, toward: string, weight: number): string {
  const channels = (hex: string) =>
    [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(1).slice(offset, offset + 2), 16)
    );
  const first = channels(from);
  const second = channels(toward);
  return `#${first
    .map((channel, index) =>
      Math.round(channel + ((second[index] ?? channel) - channel) * weight)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function colorsFor(scheme: NativeScheme, accentKey: AccentKey): NativeColors {
  const dark = scheme === "dark";
  const accent = ACCENT_PALETTE[accentKey];
  const colors: NativeColors = {
    ...iconPalette(),
    ...shared,
    accent: accent.accent,
    accentDeep: dark ? accent.light : accent.deep,
    accentFill: dark ? accent.light : accent.deep,
    accentDeepHover: mixHex(
      dark ? accent.light : accent.deep,
      dark ? "#ECEEF2" : "#141820",
      0.12
    ),
    accentLight: accent.light,
    appIdentityText: dark ? accent.light : accent.text,
    accentSoft: rgbaHex(accent.accent, dark ? 0.18 : 0.12),
    accentText: dark ? accent.accent : accent.text,
    bg: dark ? "#0D0D0D" : "#FCFCFC",
    bgChrome: dark ? "#151515" : "#F4F5F7",
    bgElev: dark ? "#1A1A1A" : "#FFFFFF",
    bgHover: dark ? "#222222" : "#F1F3F5",
    bgPress: dark ? "#2B2B2B" : "#E7EAED",
    bgSel: rgbaHex(accent.accent, dark ? 0.2 : 0.12),
    bgSunken: dark ? "#050505" : "#F0F1F3",
    line: dark ? "rgba(220,230,245,.08)" : "rgba(20,22,27,.11)",
    lineStrong: dark ? "rgba(220,230,245,.16)" : "rgba(20,22,27,.20)",
    lineSel: rgbaHex(accent.accent, dark ? 0.52 : 0.42),
    onAccent: "#141820",
    focusRingColor: accent.accent,
    scrim: dark ? "rgba(0,0,0,.72)" : "rgba(20,22,27,.52)",
    shadowLg: dark
      ? "0 30px 70px -24px rgba(0,0,0,.7)"
      : "0 24px 48px -16px rgba(20,22,27,.14)",
    shadowMd: dark
      ? "0 12px 30px -14px rgba(0,0,0,.6)"
      : "0 8px 24px -8px rgba(20,22,27,.09)",
    shadowSm: dark ? "0 1px 0 rgba(0,0,0,.35)" : "0 1px 2px rgba(20,22,27,.07)",
    text: dark ? "#ECEEF2" : "#14161B",
    textDisabled: dark ? "#858A92" : "#9BA1AA",
    textFaint: dark ? "#9AA0AA" : "#5F6672",
    textGhost: dark ? "#727780" : "#8A909A",
    textInv: dark ? "#141820" : "#F4F5F7",
    textSoft: dark ? "#ADB2BA" : "#454A54",
  };
  assertNativeColorRoleContract(colors);
  return colors;
}

export function toNativeTheme(
  scheme: NativeScheme,
  accentKey: AccentKey = "teal"
): NativeTheme {
  const nativeType = Object.fromEntries(
    Object.entries(typeForProfile("native")).map(([key, value]) => {
      const lowered = nativeTypeStyle(value);
      return [
        key,
        {
          family: lowered.family,
          fontSize: lowered.size,
          lineHeight: lowered.lineHeight,
          weight: lowered.weight,
        },
      ];
    })
  ) as Record<NativeTypeKey, NativeTypeStyle>;
  return {
    colors: colorsFor(scheme, accentKey),
    durations: { one: 120, two: 200 },
    radii,
    scheme,
    spacing,
    targetMin: { coarse: 48, fine: 32 },
    type: nativeType,
  };
}
