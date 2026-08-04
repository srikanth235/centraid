// Typed native lowering of the product grammar.
//
// This module is deliberately independent of CSS.  Every value returned here
// is concrete and ready for React Native; there is no var(), calc(),
// color-mix(), oklch(), stylesheet parser, or runtime override layer in the
// mobile path.
//
// `toNativeTheme` used to take an accent key, because an owner could retune
// the product accent to one of five hues. The Binding Layer removed that
// choice at the root: the accent is ink, so there is nothing to pick.

import { DENSITY_TIERS, metrics, spacing } from "./density";
import { paletteFor } from "./palette";
import { radii } from "./radii";
import { assertNativeColorRoleContract } from "./roles";
import { darkTheme, lightTheme } from "./themes";
import type { Theme } from "./themes";
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
  link: string;
  net: string;
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
  /** The surface-tone axis, resolved. An app picks one; only `bg` moves. */
  [key: `tone${string}`]: string;
  [key: `c${string}`]: string;
}

export interface NativeTypeStyle {
  family: Type["family"];
  fontSize: number;
  lineHeight: number;
  weight: Type["weight"];
  letterSpacing?: string;
  textTransform?: "uppercase";
  variantNumeric?: "tabular-nums";
}

export type NativeTypeKey = TypeKey;

type Type = (typeof import("./typography").type)[TypeKey];

export interface NativeTheme {
  scheme: NativeScheme;
  colors: NativeColors;
  radii: typeof radii;
  spacing: typeof spacing;
  metrics: typeof metrics;
  density: typeof DENSITY_TIERS;
  type: Record<NativeTypeKey, NativeTypeStyle>;
  targetMin: { coarse: number; fine: number };
  durations: { one: number; two: number };
}

function identityRing(scheme: NativeScheme): Record<`c${string}`, string> {
  return Object.fromEntries(
    Object.entries(paletteFor(scheme)).map(([key, value]) => [
      `c${key.slice(0, 1).toUpperCase()}${key.slice(1)}`,
      value,
    ])
  ) as Record<`c${string}`, string>;
}

function surfaceTones(theme: Theme): Record<`tone${string}`, string> {
  // Resolved from the same table the CSS emitters read, so a tone can never
  // mean one paper on the phone and another in the shell.
  const tones = {
    cool: theme.kind === "dark" ? "#0D0E0F" : "#FBFCFC",
    mat: theme.kind === "dark" ? "#0A0A0A" : "#F0EFED",
    neutral: theme.bg,
    paper: theme.kind === "dark" ? "#12110E" : "#FCFBF8",
    warm: theme.kind === "dark" ? "#131110" : "#FDFBF7",
  };
  return Object.fromEntries(
    Object.entries(tones).map(([key, value]) => [
      `tone${key.slice(0, 1).toUpperCase()}${key.slice(1)}`,
      value,
    ])
  ) as Record<`tone${string}`, string>;
}

/** `rgba()` for an alpha wash of a hex — the concrete form of the emitters'
 *  `color-mix(… N%, transparent)`, evaluated here rather than at render. */
function rgbaHex(hex: string, alpha: number): string {
  const digits = hex.slice(1);
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(digits.slice(offset, offset + 2), 16)
  );
  return `rgba(${channels.join(",")},${alpha.toString().replace(/^0(?=\.)/u, "")})`;
}

/** An opaque composite of `hex` at `alpha` over `over` — RN has no
 *  `color-mix()`, and a wash that lands on an unknown surface is a wash whose
 *  contrast nobody measured. */
function mixOver(hex: string, over: string, alpha: number): string {
  const channels = (value: string) =>
    [0, 2, 4].map((offset) =>
      Number.parseInt(value.slice(1).slice(offset, offset + 2), 16)
    );
  const fg = channels(hex);
  const bg = channels(over);
  return `#${fg
    .map((channel, index) =>
      Math.round(channel * alpha + (bg[index] ?? channel) * (1 - alpha))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function colorsFor(scheme: NativeScheme): NativeColors {
  const theme = scheme === "dark" ? darkTheme : lightTheme;
  const colors: NativeColors = {
    ...identityRing(scheme),
    ...surfaceTones(theme),
    accent: theme.accent,
    accentDeep: theme.accentDeep,
    accentFill: theme.accentDeep,
    accentDeepHover: theme.accentHover,
    accentLight: theme.accentLight,
    accentSoft: rgbaHex(theme.accent, 0.08),
    accentText: theme.accentText,
    appIdentityText: theme.text,
    bg: theme.bg,
    bgChrome: theme.sidebarBg,
    bgElev: theme.bgElev,
    bgHover: mixOver(theme.text, theme.bg, 0.05),
    bgPress: mixOver(theme.text, theme.bg, 0.09),
    bgSel: rgbaHex(theme.link, 0.12),
    bgSunken: theme.bgSunken,
    danger: theme.danger,
    line: theme.line,
    lineStrong: theme.lineStrong,
    lineSel: rgbaHex(theme.link, 0.42),
    link: theme.link,
    net: theme.net,
    onAccent: "#FDFDFC",
    focusRingColor: theme.ring,
    scrim: theme.scrim,
    shadowLg: theme.shadowLg,
    shadowMd: theme.shadowMd,
    shadowSm: theme.shadowSm,
    success: theme.success,
    text: theme.text,
    textDisabled: theme.textDisabled,
    textFaint: theme.textFaint,
    textGhost: theme.textGhost,
    textInv: theme.textInv,
    textSoft: theme.textSoft,
    warning: theme.warning,
  };
  assertNativeColorRoleContract(colors);
  return colors;
}

export function toNativeTheme(scheme: NativeScheme): NativeTheme {
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
          ...(lowered.letterSpacing === undefined
            ? {}
            : { letterSpacing: lowered.letterSpacing }),
          ...(lowered.textTransform === undefined
            ? {}
            : { textTransform: lowered.textTransform }),
          ...(lowered.variantNumeric === undefined
            ? {}
            : { variantNumeric: lowered.variantNumeric }),
        },
      ];
    })
  ) as Record<NativeTypeKey, NativeTypeStyle>;
  return {
    colors: colorsFor(scheme),
    density: DENSITY_TIERS,
    durations: { one: 140, two: 280 },
    metrics,
    radii,
    scheme,
    spacing,
    targetMin: { coarse: 48, fine: 32 },
    type: nativeType,
  };
}
