// Centraid — Theme interface + shared constants (the Binding Layer).
// Each preset under this folder builds a `Theme` literal; the
// `themes/index.ts` barrel collects them into a typed registry.
//
// THE SHELL OWNS NO HUE. Every control is ink on paper; commit is a filled ink
// button, never a colour. That is the load-bearing decision of this system: if
// the shell spends no colour, then every colour on screen provably belongs to
// an app, and the per-app identity hues in `palette.ts` actually mean
// something. `--accent` therefore survives as a ROLE NAME and resolves to ink.
//
// Exactly one hue is reserved, and never on a control: `link` for prose links
// and text selection, `ring` for the focus ring. One more, `net`, is the
// "leaves the device" red — it appears as a border or a 2px rule and never as
// a fill, because nothing alarming should be a large filled surface.

import { semanticShade } from "../color";
import type { Palette } from "../palette";

// ── Ink ────────────────────────────────────────────────────────────────────
//
// `BRAND` is the light ink and `BRAND_DARK` the dark one. The product mark is
// ink: DESIGN.md's `primary` resolves through `BRAND`, but it no longer names
// a hue — Centraid's identity is the paper and the ink on it, not a colour
// anyone else could also own.
//
// `ink3` (`--text-faint`) is the rung that decides whether this system is
// honest. It is validated against the WORST surface it can land on — in light
// that is the `mat` tone (`#F0EFED`), which is deeper than both the page and
// the raised paper, and in dark it is the raised paper (`#171716`), which is
// LIGHTER than the page. The brief specifies `#70706D` for light and validates
// it against `surf` alone; on the mat tone that measures 4.32:1, so the
// shipped value is deepened one step to `#6C6C69` (4.58:1 on mat, 5.18:1 on
// the page). That is the only place this package departs from the brief's
// colour table, and `contrast.test.ts` is what would catch it drifting back.
export const BRAND = "#141414";
export const BRAND_DARK = "#EDEDEC";
const INK_2 = "#5A5A58";
const INK_2_DARK = "#9A9A98";
const INK_3 = "#6C6C69";
const INK_3_DARK = "#878785";
// Below the ramp: placeholders and disabled glyphs. WCAG 1.4.3 exempts
// inactive controls, and these two rungs exist precisely so a recessive state
// gets its own colour token on the LEAF element instead of an `opacity` on the
// container — opacity composites every descendant and silently invalidates
// token-level contrast.
const INK_GHOST = "#888885";
const INK_GHOST_DARK = "#656563";
const INK_DISABLED = "#9C9C99";
const INK_DISABLED_DARK = "#565654";

/** The ink stepped one rung toward the paper — restrained emphasis, never a
 *  fill that carries text. */
export const ACCENT_LIGHT = "#3D3D3B";
export const ACCENT_LIGHT_DARK = "#C8C8C6";

/**
 * The ink under hover/press when it is A FILL. It steps DEEPER (light) or
 * BRIGHTER (dark), i.e. further from the ink it carries, so a hover can never
 * reduce the contrast of the label sitting on it.
 *
 * There is deliberately no `ACCENT_DEEP` or `ACCENT_TEXT` constant beside
 * these: the fill and the text rung ARE the ink, so naming them again would
 * be an alias layer with extra steps. The ROLES (`--accent-fill`,
 * `--accent-text`) still exist — a surface needs a name for the job — but they
 * resolve from `theme.accent`, and there is one value to change.
 */
export const ACCENT_HOVER = "#000000";
export const ACCENT_HOVER_DARK = "#FFFFFF";

// ── The reserved hues ──────────────────────────────────────────────────────

/** Prose links and text selection. Never permitted on a control. */
export const LINK = "#2D4BA8";
export const LINK_DARK = "#9DB0F0";
/** The focus ring, at 2px with a 2px offset. Separate from `LINK` so a focused
 *  filled-ink button gets a ring that is visible against black. */
export const RING = "#4A67C8";
export const RING_DARK = "#8098E8";
/**
 * "This leaves the device." Borders and 2px rules ONLY — never a fill.
 * `--danger` is solved from the same base so a destructive action and a
 * network egress read as the same consequence.
 */
export const NET = "#9A3B2E";
export const NET_DARK = "#E08878";

// ── The stage ──────────────────────────────────────────────────────────────
//
// The opaque media ground for a viewer, a slideshow, and an editor (Photos
// handoff v4 §2.2 / §B). Deliberately the SAME literal in both themes: the
// media ground does not follow the theme, because a viewer scrim that flipped
// to a light plane in "light mode" would blow out the photograph it is
// framing. `--stage-line` is the hairline between chrome and media ON the
// stage — `--line` is invisible against near-black, so the stage needs its
// own boundary rung rather than inheriting the page's.
export const STAGE = "#0B0B0B";
export const ON_STAGE = "#EDEDEC";
export const STAGE_LINE = "#2A2A29";
/**
 * The SOFT ink rung on the stage — capture lines, the stage's status line,
 * filmstrip labels, the editor's mono note.
 *
 * It exists because `--text-soft` follows the PAGE theme while the stage does
 * not. In light mode `--text-soft` is `#5A5A58`, tuned for near-white paper;
 * on the near-black stage that is 2.85:1 — under AA, and under it for every
 * secondary line the viewer draws. Like `--on-stage`, this rung is one literal
 * in both themes because the ground beneath it is one literal in both themes.
 * 7.15:1 against `--stage`.
 */
export const ON_STAGE_SOFT = "#9A9A98";
/**
 * The SUNKEN rung on the stage — a recess cut INTO the media ground rather
 * than a rule drawn on it: the media transport's unplayed track, and any
 * other trough whose filled part is `--on-stage`.
 *
 * The stage needs its own sunken rung for the same reason it needs its own
 * line rung: `--bg-sunken` follows the PAGE theme, and in light mode it is a
 * near-white that would punch a hole in the photograph's ground. Reaching for
 * `--stage-line` instead — the near-miss this token replaces — reads too
 * light, because a hairline is tuned to be *seen* as an edge while a trough
 * is tuned to recede under the fill it carries. One literal in both themes,
 * like every other stage role (handoff v4 line 4479, `sunken:'#1A1A19'`).
 */
export const STAGE_SUNKEN = "#1A1A19";

// ── Surfaces ───────────────────────────────────────────────────────────────
//
// Paper, not elevation. The raised surface in light mode is DARKER than the
// page (`#F5F4F2` under `#FDFDFC`) and in dark mode LIGHTER (`#171716` over
// `#0E0E0E`) — a tile is a sheet of paper laid on the page, not a plane
// floating above it.

/**
 * The per-app surface tones. An app declares one; it retunes `--bg` only —
 * the raised paper, the hairlines and the ink are invariant, which is what
 * keeps five differently-toned apps recognisably one product.
 */
export const SURFACE_TONES = {
  cool: { dark: "#0D0E0F", light: "#FBFCFC" },
  mat: { dark: "#0A0A0A", light: "#F0EFED" },
  neutral: { dark: "#0E0E0E", light: "#FDFDFC" },
  paper: { dark: "#12110E", light: "#FCFBF8" },
  warm: { dark: "#131110", light: "#FDFBF7" },
} as const;

export type SurfaceTone = keyof typeof SURFACE_TONES;

/** Tone order, as the tone axis is documented and emitted. */
export const SURFACE_TONE_NAMES = [
  "neutral",
  "paper",
  "mat",
  "cool",
  "warm",
] as const satisfies readonly SurfaceTone[];

// ── Semantic states ────────────────────────────────────────────────────────
//
// Kept as roles because recipes and ~130 stylesheet sites reference them, and
// re-solved for the ink-on-paper world: low chroma, legible as TEXT on every
// surface AND on a 12% wash of themselves, and never a large filled surface.
// `semanticShade()` walks each base along its own hue — hue and saturation
// never move — to the lightest/deepest shade that clears 4.8:1, so "darken it
// until it passes" cannot quietly turn a state into a grey.
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

export interface Theme {
  /** Light vs dark family — drives the picker grouping. Must equal the
   * theme's registry key; see themes/index.ts. */
  kind: "light" | "dark";

  /** Ink as the action colour — the one filled control per view. */
  accent: string;
  /** Ink stepped toward the paper, for restrained emphasis. */
  accentLight: string;
  /** Ink AS A FILL. Same value as `accent`; the role names the job. */
  accentDeep: string;
  /** The fill under hover/press — further from the ink it carries. */
  accentHover: string;
  /** Ink as text. */
  accentText: string;

  /** Positive state — complete, connected. Text and rules, never a fill. */
  success: string;
  /** Negative state — destructive confirmations, errors. Outline, never fill. */
  danger: string;
  /** Cautionary state — over-budget readings, degraded status. */
  warning: string;
  /** "Leaves the device" — borders and 2px rules only. */
  net: string;
  /** Prose links and text selection. Never on a control. */
  link: string;
  /** The focus ring. */
  ring: string;

  // Surfaces (page → raised paper)
  bg: string;
  bgSunken: string;
  bgElev: string;
  bgApp: string;
  /** The ground a tile paints before its bytes arrive. `--bg-elev` reads as a
   *  card; an absence is not a card, so a loading tile gets its own rung. */
  skel: string;

  // Text (text + icon foreground). Roles, not arbitrary brightness rungs.
  text: string;
  textSoft: string;
  textFaint: string;
  textGhost: string;
  textDisabled: string;
  textInv: string;

  // Hairlines. `line` is the LIGHT rung the brief calls `lineS` (separators,
  // tile borders); `lineStrong` is the brief's `line` (control borders,
  // section rules). The repo's names already ordered them that way.
  line: string;
  lineStrong: string;
  /** Modal and image-overlay veil. */
  scrim: string;

  // Shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  /** The wall behind the frame. */
  bgWall: string;

  /** Signature backdrop behind any "device" surface. Desktop-only. */
  deviceWall: string;

  /** The stem/chrome surface. Never themed by an app. */
  sidebarBg: string;
  sidebarBlur: string;
  sidebarDivider: string;

  /** The app identity ring for this theme. */
  palette: Palette;
}

// ── Motion ─────────────────────────────────────────────────────────────────
//
// Two cases, two curves, and that is the whole grammar. Entry/settle is slow
// and lands softly; a state change is quick and decisive. `prefers-reduced-
// motion` is honoured in ONE global rule (see `toCss`), never per component.
export const EASE = "cubic-bezier(0.3, 0, 0.4, 1)";
export const EASE_ENTRY = "cubic-bezier(0.2, 0.7, 0.2, 1)";
export const DUR_STATE = "140ms";
export const DUR_ENTRY = "280ms";

// The ink ramp rungs, exported for the two theme presets below.
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
