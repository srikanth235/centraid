// Centraid Light + Dark — the shipping defaults, in the Binding Layer.
//
// Both ramps are LITERAL. The dark ramp used to derive every surface from a
// single `--bg-l` anchor through `hsl(0 0% calc(...))`, which was the right
// mechanism for a pure-greyscale ramp; the Binding Layer's dark surfaces are
// warm-tinted paper (`#171716`, not `hsl(0 0% 9%)`), so a one-knob greyscale
// calc can no longer express them and has been retired rather than faked with
// a saturation parameter. A surface is now a value you can read.
//
// The surface order is PAPER, not elevation: in light the raised surface is
// DARKER than the page, in dark it is LIGHTER. A tile is a sheet laid on the
// page, not a plane floating above it.

import { palette, paletteDark } from "../palette";
import {
  ACCENT_HOVER,
  ACCENT_HOVER_DARK,
  ACCENT_LIGHT,
  ACCENT_LIGHT_DARK,
  BRAND,
  BRAND_DARK,
  DANGER,
  DANGER_DARK,
  INK_RAMP,
  LINK,
  LINK_DARK,
  NET,
  NET_DARK,
  RING,
  RING_DARK,
  SUCCESS,
  SUCCESS_LIGHT,
  SURFACE_TONES,
  WARNING,
  WARNING_LIGHT,
} from "./shared";
import type { Theme } from "./shared";

export const lightTheme: Theme = {
  kind: "light",
  accent: BRAND,
  accentDeep: BRAND,
  accentHover: ACCENT_HOVER,
  accentLight: ACCENT_LIGHT,
  accentText: BRAND,
  // The page is the `neutral` tone; an app may retune THIS role and nothing
  // else on the surface axis.
  bg: SURFACE_TONES.neutral.light,
  // The wall behind the frame is the deepest paper an app may declare, which
  // is also why `mat` is the surface every solved ink rung is scored against.
  bgApp: SURFACE_TONES.mat.light,
  // `surf` — tiles, the today cell, the hover ground.
  bgElev: "#F5F4F2",
  // A recessed track sits between the page and the raised paper: deep enough
  // to read as a groove, light enough that `--text-faint` still clears AA on
  // it. Deeper than this and the metadata ramp starts failing.
  bgSunken: "#F9F8F6",
  bgWall: SURFACE_TONES.mat.light,
  deviceWall:
    "repeating-linear-gradient(0deg, transparent 0 23px, rgba(20,20,20,.035) 23px 24px), " +
    "repeating-linear-gradient(90deg, transparent 0 23px, rgba(20,20,20,.035) 23px 24px), " +
    "linear-gradient(180deg, #EAE9E6 0%, #E1E0DC 100%)",
  // The ground a photo tile paints before its bytes arrive — deeper than
  // `--bg-elev` (a card) because an absence is not a card.
  skel: "#E4E3E0",
  // Measured against the page: text 18.1:1, soft 6.8:1, faint 5.2:1,
  // ghost 3.5:1 — and against the `mat` tone, the hardest surface in the
  // system: 16.0 / 6.0 / 4.6 / 3.1. `contrast.test.ts` re-measures both off
  // the emitted CSS.
  text: INK_RAMP.light.text,
  textSoft: INK_RAMP.light.soft,
  textFaint: INK_RAMP.light.faint,
  textGhost: INK_RAMP.light.ghost,
  textDisabled: INK_RAMP.light.disabled,
  // Ink ON a filled ink control — the page colour, not pure white.
  textInv: SURFACE_TONES.neutral.light,
  // `line` is the hairline (separators, tile borders); `lineStrong` is the
  // explicit boundary (control borders, section rules).
  line: "#EFEEEB",
  lineStrong: "#E5E4E1",
  link: LINK,
  net: NET,
  ring: RING,
  // The veil, at the handoff's own strength (v4 line 5101,
  // `dark?'rgba(0,0,0,.62)':'rgba(26,24,21,.3)'`). Two corrections in one:
  // the ALPHA was 0.48, half again as heavy as specified, and the TINT was
  // the cool `20,20,20` ink rather than the warm `26,24,21` the ink-on-paper
  // flip settled on. A veil is meant to say "the thing behind this is still
  // there"; at 48% on a warm paper it read as a cold grey plate.
  scrim: "rgba(26,24,21,0.3)",
  palette,
  shadowLg: "0 24px 48px -16px rgba(20,20,20,.16)",
  shadowMd: "0 8px 24px -8px rgba(20,20,20,.10)",
  shadowSm: "0 1px 2px rgba(20,20,20,.06)",
  // The stem is chrome, and chrome is paper. No glass, no gloss, no gradient:
  // the metaphor is a tinted paper label, not a button under a lens.
  sidebarBg: "#F5F4F2",
  sidebarBlur: "none",
  sidebarDivider: "1px solid #E5E4E1",
  success: SUCCESS_LIGHT,
  danger: DANGER,
  warning: WARNING_LIGHT,
};

export const darkTheme: Theme = {
  kind: "dark",
  accent: BRAND_DARK,
  accentDeep: BRAND_DARK,
  accentHover: ACCENT_HOVER_DARK,
  accentLight: ACCENT_LIGHT_DARK,
  accentText: BRAND_DARK,
  bg: SURFACE_TONES.neutral.dark,
  bgApp: "#060606",
  // `surf` — LIGHTER than the page here, which is why `--text-faint` is
  // validated against this surface and not against `--bg`.
  bgElev: "#171716",
  bgSunken: "#121211",
  bgWall: SURFACE_TONES.mat.dark,
  deviceWall:
    "repeating-linear-gradient(0deg, transparent 0 23px, rgba(255,255,255,.022) 23px 24px), " +
    "repeating-linear-gradient(90deg, transparent 0 23px, rgba(255,255,255,.022) 23px 24px), " +
    "var(--bg-wall)",
  skel: "#1E1E1D",
  text: INK_RAMP.dark.text,
  textSoft: INK_RAMP.dark.soft,
  textFaint: INK_RAMP.dark.faint,
  textGhost: INK_RAMP.dark.ghost,
  textDisabled: INK_RAMP.dark.disabled,
  textInv: SURFACE_TONES.neutral.dark,
  line: "#1B1B1A",
  lineStrong: "#232322",
  link: LINK_DARK,
  net: NET_DARK,
  ring: RING_DARK,
  // 0.62, the handoff's dark value (v4 line 5101) — was 0.72, which on an
  // already near-black page left almost nothing of the surface behind it.
  scrim: "rgba(0,0,0,0.62)",
  palette: paletteDark,
  shadowLg: "0 30px 70px -24px rgba(0,0,0,.7)",
  shadowMd: "0 12px 30px -14px rgba(0,0,0,.6)",
  shadowSm: "0 1px 0 rgba(0,0,0,.4)",
  sidebarBg: "#121211",
  sidebarBlur: "none",
  sidebarDivider: "1px solid #232322",
  success: SUCCESS,
  danger: DANGER_DARK,
  warning: WARNING,
};
