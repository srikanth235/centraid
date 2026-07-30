// Centraid Light + Dark — the shipping defaults.
// Light: Notion/Linear-inspired near-white surfaces with warm dark ink.
// Dark: a neutral greyscale ramp derived from a single `--bg-l` knob so the
// whole surface ramp retunes by changing one value. Mobile reads
// `themes.light` directly, so the dark theme's `var()` references —
// which RN cannot resolve — never reach it.

import { palette } from "../palette";
import {
  ACCENT_DEEP,
  ACCENT_LIGHT,
  ACCENT_MIDNIGHT,
  ACCENT_VIOLET,
  BRAND,
  DANGER,
  SUCCESS,
} from "./shared";
import type { Theme } from "./shared";

export const lightTheme: Theme = {
  kind: "light",
  accent: BRAND,
  accentDeep: ACCENT_DEEP,
  accentLight: ACCENT_LIGHT,
  accentMidnight: ACCENT_MIDNIGHT,
  accentViolet: ACCENT_VIOLET,
  bg: "#FCFCFC",
  bgApp: "#FFFFFF",
  bgElev: "#FFFFFF",
  bgSunken: "#F0F1F3",
  bgWall: "#FCFCFC",
  bezel: "#14181F",
  bezelInner: "#1f242d",
  deviceWall:
    "repeating-linear-gradient(0deg, transparent 0 23px, rgba(20,24,32,.04) 23px 24px), " +
    "repeating-linear-gradient(90deg, transparent 0 23px, rgba(20,24,32,.04) 23px 24px), " +
    "linear-gradient(180deg, #dee0e4 0%, #d2d5db 100%)",
  ink: "#1F1F23",
  ink2: "rgba(31,31,35,0.72)",
  ink3: "rgba(31,31,35,0.50)",
  ink4: "rgba(31,31,35,0.28)",
  inkInv: "#F4F5F7",
  line: "rgba(31,31,35,0.07)",
  lineStrong: "rgba(31,31,35,0.13)",
  palette,
  shadowLg:
    "0 1px 2px rgba(31,31,35,.04), 0 24px 48px -16px rgba(31,31,35,.10)",
  shadowMd: "0 1px 2px rgba(31,31,35,.04), 0 8px 24px -8px rgba(31,31,35,.06)",
  shadowSm: "0 1px 2px rgba(31,31,35,.05)",
  sidebarBg: "#F4F5F7",
  sidebarBlur: "none",
  sidebarDivider: "1px solid rgba(31,31,35,0.08)",
  success: SUCCESS,
  danger: DANGER,
};

export const darkTheme: Theme = {
  kind: "dark",
  accent: BRAND,
  accentDeep: ACCENT_DEEP,
  accentLight: ACCENT_LIGHT,
  accentMidnight: ACCENT_MIDNIGHT,
  accentViolet: ACCENT_VIOLET,
  // The ramp is neutral greyscale, and that is the only dark ramp there is
  // (#608). A hue/saturation "surface temperature" knob used to sit on top of
  // this; it was cut for parity — the light theme has no temperature, so the
  // dark one having three made the two halves of the same setting behave
  // differently for no reason a member could name.
  //
  // The anchor is `5%` because that is the surface Centraid Dark has always
  // rendered — the near-black the product is known by, not the mid-grey a
  // literal `18%` produces. `18%` sat here unread while the pref layer forced
  // `5%` inline over it, so it was never the shipped ramp; once the precedence
  // was corrected (a theme's own values render), the declaration had to become
  // the value that was actually on screen rather than the reverse.
  //
  // Every surface below derives from `--bg-l`, so moving that one anchor
  // retunes the whole ramp. `--bg-app` is `calc(5% - 5%)`, i.e. true black —
  // inherited from the shipped ramp, and deliberate.
  bgL: "5%",
  bg: "hsl(0 0% var(--bg-l))",
  bgApp: "hsl(0 0% calc(var(--bg-l) - 5%))",
  bgElev: "hsl(0 0% calc(var(--bg-l) + 4.5%))",
  bgSunken: "hsl(0 0% calc(var(--bg-l) - 4%))",
  // The `--device-wall` composite layers its crosshatch over `var(--bg-wall)`,
  // so redefining the wall retunes both in one place.
  bgWall:
    "linear-gradient(180deg, hsl(0 0% calc(var(--bg-l) + 2%)) 0%, " +
    "hsl(0 0% calc(var(--bg-l) - 2%)) 100%)",
  sidebarBg:
    "linear-gradient(180deg, hsl(0 0% calc(var(--bg-l) + 5%) / 0.92) 0%, " +
    "hsl(0 0% calc(var(--bg-l) + 2%) / 0.92) 100%)",
  bezel: "#0a0d13",
  bezelInner: "#14181F",
  deviceWall:
    "repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), " +
    "repeating-linear-gradient(90deg, transparent 0 23px, rgba(255,255,255,.025) 23px 24px), " +
    "var(--bg-wall)",
  ink: "#ECEEF2",
  ink2: "rgba(236,238,242,0.72)",
  ink3: "rgba(236,238,242,0.52)",
  ink4: "rgba(236,238,242,0.32)",
  inkInv: "#141820",
  line: "rgba(220,230,245,0.08)",
  lineStrong: "rgba(220,230,245,0.16)",
  palette,
  shadowLg: "0 2px 4px rgba(0,0,0,.35), 0 32px 64px -16px rgba(0,0,0,.55)",
  shadowMd: "0 1px 0 rgba(0,0,0,.35), 0 12px 32px -8px rgba(0,0,0,.45)",
  shadowSm: "0 1px 0 rgba(0,0,0,.35)",
  sidebarBlur: "blur(28px) saturate(180%)",
  sidebarDivider: "0.5px solid rgba(255,255,255,0.10)",
  success: SUCCESS,
  danger: DANGER,
};
