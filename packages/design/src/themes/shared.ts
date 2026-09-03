import { rgbaHex, semanticShade } from "../color";
import type { Palette } from "../palette";

export const BRAND = "#141414";
export const BRAND_DARK = "#EDEDEC";
const INK_2 = "#5A5A58";
const INK_2_DARK = "#9A9A98";
const INK_3 = "#6C6C69";
const INK_3_DARK = "#878785";
const INK_GHOST = "#888885";
const INK_GHOST_DARK = "#656563";
const INK_DISABLED = "#9C9C99";
const INK_DISABLED_DARK = "#565654";

export const ACCENT_LIGHT = "#3D3D3B";
export const ACCENT_LIGHT_DARK = "#C8C8C6";

export const ACCENT_HOVER = "#000000";
export const ACCENT_HOVER_DARK = "#FFFFFF";

export const ACCENT_INK_HOVER = "#2E2E2D";
export const ACCENT_INK_HOVER_DARK = "#D2D2D1";

export const LINK = "#2D4BA8";
export const LINK_DARK = "#9DB0F0";
export const RING = "#4A67C8";
export const RING_DARK = "#8098E8";
export const NET = "#9A3B2E";
export const NET_DARK = "#E08878";
export const NET_HOVER = "#7F3026";
export const NET_HOVER_DARK = "#EC9C8D";
const NET_WASH_ALPHA = { dark: 0.11, light: 0.07 } as const;
export const NET_WASH = rgbaHex(NET, NET_WASH_ALPHA.light);
export const NET_WASH_DARK = rgbaHex(NET_DARK, NET_WASH_ALPHA.dark);
export const SEAM = "#B4441F";
export const SEAM_DARK = "#E0864F";

export const STAGE = "#0B0B0B";
export const ON_STAGE = "#EDEDEC";
export const STAGE_LINE = "#2A2A29";
export const ON_STAGE_SOFT = "#9A9A98";

export const STAGE_SUNKEN = "#1A1A19";

export const PAGE = { dark: "#0E0E0E", light: "#FDFDFC" } as const;
export const WALL = { dark: "#060606", light: "#F0EFED" } as const;

const DANGER_BASE_LIGHT = NET;
const DANGER_BASE_DARK = NET_DARK;
const SUCCESS_BASE_LIGHT = "#3E6B44";
const SUCCESS_BASE_DARK = "#7FB588";
const WARNING_BASE_LIGHT = "#7C5619";
const WARNING_BASE_DARK = "#D9A75B";

export const DANGER = semanticShade(DANGER_BASE_LIGHT, "light");
export const DANGER_DARK = semanticShade(DANGER_BASE_DARK, "dark");
export const SUCCESS_LIGHT = semanticShade(SUCCESS_BASE_LIGHT, "light");
export const SUCCESS = semanticShade(SUCCESS_BASE_DARK, "dark");
export const WARNING_LIGHT = semanticShade(WARNING_BASE_LIGHT, "light");
export const WARNING = semanticShade(WARNING_BASE_DARK, "dark");

export const ATTENTION = "#8A6520";
export const ATTENTION_DARK = "#D8A64E";

export interface Theme {
  kind: "light" | "dark";

  accent: string;
  accentLight: string;
  accentDeep: string;
  accentHover: string;
  accentInkHover: string;
  accentText: string;

  success: string;
  danger: string;
  warning: string;
  attention: string;
  net: string;
  netHover: string;
  netWash: string;
  seam: string;
  link: string;
  ring: string;

  bg: string;
  bgSunken: string;
  bgElev: string;
  bgApp: string;
  skel: string;

  text: string;
  textSoft: string;
  textFaint: string;
  textGhost: string;
  textDisabled: string;
  textInv: string;

  line: string;
  lineStrong: string;
  scrim: string;

  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  bgWall: string;

  deviceWall: string;

  sidebarBg: string;
  sidebarBlur: string;
  sidebarDivider: string;

  palette: Palette;
}

export const EASE = "cubic-bezier(0.3, 0, 0.4, 1)";
export const EASE_ENTRY = "cubic-bezier(0.2, 0.7, 0.2, 1)";
export const DUR_STATE = "140ms";
export const DUR_ENTRY = "280ms";

export const INK_RAMP = {
  dark: {
    disabled: INK_DISABLED_DARK,
    faint: INK_3_DARK,
    ghost: INK_GHOST_DARK,
    soft: INK_2_DARK,
    text: BRAND_DARK,
  },
  light: {
    disabled: INK_DISABLED,
    faint: INK_3,
    ghost: INK_GHOST,
    soft: INK_2,
    text: BRAND,
  },
} as const;
