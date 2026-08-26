// Theme interface + shared constants (the Binding Layer). Each preset here
// builds a `Theme` literal; `themes/index.ts` collects them.
//
// THE SHELL OWNS NO HUE: every control is ink on paper, so every colour on
// screen provably belongs to an app. `--accent` survives as a ROLE NAME and
// resolves to ink. Only `link`, `ring` and `net` are reserved hues, and `net`
// is a border or 2px rule, never a fill.

import { rgbaHex, semanticShade } from "../color";
import type { Palette } from "../palette";

// ── Ink ────────────────────────────────────────────────────────────────────
//
// The product mark is INK, not a hue. Every rung is validated against the WORST
// surface it can land on — `WALL` in light, the raised paper in dark. Deepening
// a rung buys contrast the floors do not ask for and flattens four rungs into
// one grey, which is what `contrast.test.ts`'s ramp-ordering assertion names.
export const BRAND = "#141414";
export const BRAND_DARK = "#EDEDEC";
const INK_2 = "#5A5A58";
const INK_2_DARK = "#9A9A98";
const INK_3 = "#6C6C69";
const INK_3_DARK = "#878785";
// Below the ramp: placeholders and disabled glyphs, so a recessive state gets a
// token on the LEAF element instead of an `opacity` on the container — opacity
// composites every descendant and silently invalidates token contrast.
const INK_GHOST = "#888885";
const INK_GHOST_DARK = "#656563";
const INK_DISABLED = "#9C9C99";
const INK_DISABLED_DARK = "#565654";

export const ACCENT_LIGHT = "#3D3D3B";
export const ACCENT_LIGHT_DARK = "#C8C8C6";

/** Hover on A FILL steps further from the ink it carries, so it can never
 *  reduce the label's contrast. There is deliberately no `ACCENT_DEEP` or
 *  `ACCENT_TEXT` constant: the roles resolve from `theme.accent`. */
export const ACCENT_HOVER = "#000000";
export const ACCENT_HOVER_DARK = "#FFFFFF";

/** Hover on a LINE-AND-LABEL steps the opposite way from `ACCENT_HOVER`, and
 *  the asymmetry is forced: the accent sits at the ramp's extreme, so an
 *  outline's own ink can only move toward the paper. Nothing rides on top of
 *  it, so that costs contrast against the page and nothing else. */
export const ACCENT_INK_HOVER = "#2E2E2D";
export const ACCENT_INK_HOVER_DARK = "#D2D2D1";

// ── The reserved hues ──────────────────────────────────────────────────────

export const LINK = "#2D4BA8";
export const LINK_DARK = "#9DB0F0";
/** Separate from `LINK`, so a focused ink fill gets a visible ring. */
export const RING = "#4A67C8";
export const RING_DARK = "#8098E8";
/** "This leaves the device": borders and 2px rules ONLY, never a fill.
 *  `--danger` is solved from the same base. */
export const NET = "#9A3B2E";
export const NET_DARK = "#E08878";
/** Unlike `ACCENT_INK_HOVER` this steps AWAY from the paper: `NET` is not at
 *  its ramp's end, and a warning that quietens under the pointer is wrong. */
export const NET_HOVER = "#7F3026";
export const NET_HOVER_DARK = "#EC9C8D";
/** The ONE tint of `NET` permitted: faint enough that the ink ramp still clears
 *  AA on it, which is what keeps it from becoming the alarming surface `--net`
 *  forbids. DERIVED from `NET`, never re-typed. */
const NET_WASH_ALPHA = { dark: 0.11, light: 0.07 } as const;
export const NET_WASH = rgbaHex(NET, NET_WASH_ALPHA.light);
export const NET_WASH_DARK = rgbaHex(NET_DARK, NET_WASH_ALPHA.dark);
/** "Not yet, and not wrong" — pending, expiring, invited; the state `--warning`
 *  and `--net` do not cover. Border, chip and text only, never a filled
 *  surface. */
export const SEAM = "#B4441F";
export const SEAM_DARK = "#E0864F";

// ── The stage ──────────────────────────────────────────────────────────────
//
// The opaque media ground. Deliberately the SAME literal in both themes: a
// viewer scrim that flipped light would blow out the photograph it frames.
// `--line` is invisible against near-black, so the stage owns its boundary rung.
export const STAGE = "#0B0B0B";
export const ON_STAGE = "#EDEDEC";
export const STAGE_LINE = "#2A2A29";
/** `--text-soft` follows the PAGE theme while the stage does not: in light it
 *  measures 2.85:1 on the stage, under AA. One literal in both themes, because
 *  the ground beneath it is. */
export const ON_STAGE_SOFT = "#9A9A98";
/** A recess cut INTO the media ground. `--bg-sunken` follows the PAGE theme and
 *  would punch a near-white hole in it; `--stage-line` reads too light, being
 *  tuned to be SEEN as an edge rather than to recede under a fill. */
export const STAGE_SUNKEN = "#1A1A19";

// ── Surfaces ───────────────────────────────────────────────────────────────
//
// Paper, not elevation: the raised surface is DARKER than the page in light and
// LIGHTER in dark — a sheet laid on the page, not a plane floating above it.

/** ONE PAGE: the shell and every app share this colour, and a `data-tone` page
 *  axis is dead by decision — retuning `--bg` alone inverts the paper metaphor,
 *  and the measured spread was imperceptible. If a page tone ever returns it
 *  must carry its whole surface SET, never `--bg` alone
 *  (docs/traps/design-tokens.md). */
export const PAGE = { dark: "#0E0E0E", light: "#FDFDFC" } as const;
/** The deepest paper in the system, and why the ink ramp is solved against it
 *  rather than the page. Not a tone an app may declare. The desktop stem paints
 *  it too: navigation belongs to the FRAME, never to the app's page. */
export const WALL = { dark: "#060606", light: "#F0EFED" } as const;

// ── Semantic states ────────────────────────────────────────────────────────
//
// Low chroma, legible as TEXT on every surface AND on a 12% wash of themselves,
// never a large filled surface. `semanticShade()` walks each base along its OWN
// hue — hue and saturation never move — so "darken until it passes" cannot turn
// a state into a grey.
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

/** The signal vocabulary's middle rung: type, a border, or a 2px rule. */
export const ATTENTION = "#8A6520";
export const ATTENTION_DARK = "#D8A64E";

export interface Theme {
  /** Must equal the theme's registry key (themes/index.ts). */
  kind: "light" | "dark";

  /** Ink as the action colour — the one filled control per view. */
  accent: string;
  accentLight: string;
  /** Ink AS A FILL. Same value as `accent`; the role names the job. */
  accentDeep: string;
  accentHover: string;
  /** Hover for the LINE-AND-LABEL control, stepping toward the paper. */
  accentInkHover: string;
  accentText: string;

  /** Text and rules, never a fill. */
  success: string;
  /** Outline, never a fill. */
  danger: string;
  warning: string;
  /** Notice without interruption. Never a fill. */
  attention: string;
  /** "Leaves the device" — borders and 2px rules only. */
  net: string;
  netHover: string;
  /** The one permitted tint of `net`. */
  netWash: string;
  /** "Not yet, and not wrong" — pending, expiring, invited. */
  seam: string;
  link: string;
  ring: string;

  // Surfaces (page → raised paper)
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

  // `line` is separators and tile borders; `lineStrong` is control borders and
  // section rules.
  line: string;
  lineStrong: string;
  scrim: string;

  // Shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  bgWall: string;

  /** Desktop-only backdrop behind any "device" surface. */
  deviceWall: string;

  /** The stem/chrome surface. Never themed by an app. */
  sidebarBg: string;
  sidebarBlur: string;
  sidebarDivider: string;

  palette: Palette;
}

// ── Motion ─────────────────────────────────────────────────────────────────
//
// Two cases, two curves, and that is the whole grammar. `prefers-reduced-motion`
// is honoured in ONE global rule (`toCss`), never per component.
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
