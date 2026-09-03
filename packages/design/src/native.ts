import { borders } from "./borders";
import { rgbaHex } from "./color";
import { DENSITY_TIERS, metrics, pageMargin, spacing } from "./density";
import { paletteFor } from "./palette";
import { radii } from "./radii";
import { assertNativeColorRoleContract } from "./roles";
import {
  darkTheme,
  lightTheme,
  ON_STAGE,
  ON_STAGE_SOFT,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
} from "./themes";
import { nativeTypeStyle, typeForProfile } from "./typography";
import type { TypeKey } from "./typography";

export type NativeScheme = "dark" | "light";

export interface NativeColors {
  accent: string;
  accentDeep: string;
  accentFill: string;
  accentDeepHover: string;
  accentInkHover: string;
  accentLight: string;
  accentSoft: string;
  accentText: string;
  appIdentityText: string;
  attention: string;
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
  netHover: string;
  netWash: string;
  onAccent: string;
  onStage: string;
  onStageSoft: string;
  focusRingColor: string;
  scrim: string;
  seam: string;
  shadowLg: string;
  shadowMd: string;
  shadowSm: string;
  skel: string;
  stage: string;
  stageLine: string;
  stageSunken: string;
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
  letterSpacing?: string;
  textTransform?: "uppercase";
  variantNumeric?: "tabular-nums";
  direction?: "ltr";
  unicodeBidi?: "isolate";
}

export type NativeTypeKey = TypeKey;

type Type = (typeof import("./typography").type)[TypeKey];

export interface NativeTheme {
  scheme: NativeScheme;
  colors: NativeColors;
  radii: typeof radii;
  borders: typeof borders;
  spacing: typeof spacing;
  metrics: typeof metrics;
  pageMargin: number;
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
    accent: theme.accent,
    accentDeep: theme.accentDeep,
    accentFill: theme.accentDeep,
    accentDeepHover: theme.accentHover,
    accentInkHover: theme.accentInkHover,
    accentLight: theme.accentLight,
    accentSoft: rgbaHex(theme.accent, 0.08),
    accentText: theme.accentText,
    appIdentityText: theme.text,
    attention: theme.attention,
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
    netHover: theme.netHover,
    netWash: theme.netWash,
    onAccent: theme.textInv,
    onStage: ON_STAGE,
    onStageSoft: ON_STAGE_SOFT,
    focusRingColor: theme.ring,
    scrim: theme.scrim,
    seam: theme.seam,
    shadowLg: theme.shadowLg,
    shadowMd: theme.shadowMd,
    shadowSm: theme.shadowSm,
    skel: theme.skel,
    stage: STAGE,
    stageLine: STAGE_LINE,
    stageSunken: STAGE_SUNKEN,
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
          ...(lowered.direction === undefined
            ? {}
            : { direction: lowered.direction }),
          ...(lowered.unicodeBidi === undefined
            ? {}
            : { unicodeBidi: lowered.unicodeBidi }),
        },
      ];
    })
  ) as Record<NativeTypeKey, NativeTypeStyle>;
  return {
    borders,
    colors: colorsFor(scheme),
    density: DENSITY_TIERS,
    durations: { one: 140, two: 280 },
    metrics,
    pageMargin: pageMargin.mobile,
    radii,
    scheme,
    spacing,
    targetMin: { coarse: metrics.controlTouch, fine: metrics.control },
    type: nativeType,
  };
}
