// Centraid — Theme interface + shared constants.
// Each preset under this folder builds a `Theme` literal; the
// `themes/index.ts` barrel collects them into a typed registry.

import { semanticShade } from "../color";
import type { Palette } from "../palette";

// Brand teal — the single source of truth for the Centraid identity.
// This is the exact hue used by the logo + app-icon marks; the SVG
// assets under `assets/` and `docs/assets/` hardcode this same hex, and
// `toCss()` emits it as a theme-independent `--brand` var.
export const BRAND = "#3EC8B4";

// Teal accent ramp derived from BRAND. Used for the FAB, sparkle button,
// primary CTAs, brand mark, focus rings, and active state in version
// history. Both registered themes declare this accent, and the pref layer
// only overrides it once the owner picks a different one (#608 group P).
// The base accent is BRAND itself (see above); the ramp extends from it.
export const ACCENT_LIGHT = "#62D6C6";
export const ACCENT_MIDNIGHT = "#12645A";

// The accent as a FILLED surface — the primary button, the brand mark, the
// pressed chip. This rung is the one place the accent carries text, so it is
// not a free hand-pick: it is solved so `--text-inv` clears AA **on** it.
//
// The old `#2AA593` was a lightness nudge off BRAND and measured 3.04:1 under
// white — a real WCAG 1.4.3 failure the `@google/design.md` linter surfaced
// (#686 F3). CSS has no shipped way to choose the ink from the background
// (`color-contrast()` is unimplemented and `color-mix()` cannot branch), and
// an app may retune the accent to any of the eight palette hues, so the FILL
// is what moves: `accentFillShade()` in `../color.ts` walks BRAND down its own
// hue to the lightest shade that clears 4.8:1. Saturation and hue are
// untouched — this is still unmistakably the brand teal, one stop before
// `--accent-midnight`.
//
// The two ramps take OPPOSITE halves of the same pair, because `--text-inv`
// itself flips: near-white (#F4F5F7) on light, near-black (#141820) on dark.
// So the light ramp fills deep and the dark ramp fills lifted — 4.91:1 and
// 7.16:1 respectively. `contrast.test.ts` measures both off the emitted CSS.
export const ACCENT_DEEP = "#22776B";
export const ACCENT_DEEP_DARK = "#34B7A4";

// Ink for a FULLY SATURATED accent or a media scrim — the photo lightbox
// chrome, the capture overlay, an `--accent`-filled badge. Theme-independent
// white, because those surfaces are dark in both themes (a photo, a 52%
// scrim). It is NOT the ink for `--accent-deep`: that pair flips per theme
// and is `--text-inv`. The shell never emitted this name, so the five
// `var(--on-accent)` rules in `packages/client` resolved to nothing and
// inherited the surrounding ink (#686 F3).
export const ON_ACCENT = "#FFFFFF";

// BRAND as TEXT. It is legible as a button face with white on it, and as text
// on the dark ramp (9.4:1), but on a near-white surface it lands at 2.0:1 —
// below the floor for text at any size. Every `color: var(--accent-text)` site
// reads this instead, so a light surface gets a deepened teal that still reads
// as the brand hue (5.1:1 on `--bg`). Fills and focus rings keep `--accent`.
export const ACCENT_TEXT_LIGHT = "#0F7A6C";

// Semantic states, as TEXT. All three are overwhelmingly `color:` on small
// prose in this repo (131 `color:` rules between them, 9–13.7px, none of them
// large text), so each is SOLVED rather than hand-picked — `semanticShade()`
// walks the base along its own hue to the lightest/deepest shade that clears
// 4.8:1 on the hardest shell surface and on a 12% self-tint of itself there
// (the `color-mix(… var(--danger) 12%, transparent)` chip is the commonest
// site of all). Hue and saturation never move.
//
// The hand-picked values these replace all missed the body floor somewhere:
// `#C44A4A` measured 3.74:1 on dark `--bg-elev` and 4.20:1 on light
// `--bg-sunken` — DESIGN.md claimed it "clears AA on both ramps" and nothing
// pinned the claim, because `contrast.test.ts` held these three roles to the
// 3:1 NON-TEXT floor and only on `--bg`. `#9A6B1F` was 4.13:1 on light
// `--bg-sunken` and `#5C8A4E` 4.40:1 on dark `--bg-elev`. `#E0A94A` was the
// one that already cleared, and the solver leaves it untouched.
//
// DANGER is no longer shared across the ramps: the two surfaces pull in
// opposite directions (deepen under near-white, lift under near-black), which
// is why one literal could not clear both.
const DANGER_BASE = "#C44A4A";
const SUCCESS_BASE_DARK = "#5C8A4E";
const SUCCESS_BASE_LIGHT = "#456B39";
// Amber is the hue; each ramp takes the lightness its own surfaces allow. The
// role became a contract token in #672, after the kit and the client both
// painted `var(--warn)` — a name no emitter ever defined.
const WARNING_BASE_DARK = "#E0A94A";
const WARNING_BASE_LIGHT = "#9A6B1F";

export const SUCCESS = semanticShade(SUCCESS_BASE_DARK, "shellDark");
export const SUCCESS_LIGHT = semanticShade(SUCCESS_BASE_LIGHT, "shellLight");
export const DANGER = semanticShade(DANGER_BASE, "shellLight");
export const DANGER_DARK = semanticShade(DANGER_BASE, "shellDark");
export const WARNING = semanticShade(WARNING_BASE_DARK, "shellDark");
export const WARNING_LIGHT = semanticShade(WARNING_BASE_LIGHT, "shellLight");

// The phone-frame bezel constants that used to live here existed so six
// emulation presets could share one value. With the registry cut to Centraid
// Light + Dark (#608 group O) both themes declare their own `bezel` /
// `bezelInner` in centraid.ts, which is also the only file that reads them.

export interface Theme {
  /** Light vs dark family — drives the picker grouping and the
   * applicability of dark-only tuning knobs (surface temperature, --bg-l).
   * Must equal the theme's registry key; see themes/index.ts. */
  kind: "light" | "dark";

  /** Single brand accent — FAB, sparkle, primary CTAs, focus rings. */
  accent: string;
  /** Lighter accent for "new" badges / hovered active rows. */
  accentLight: string;
  /** Darker accent for pressed states / depth. */
  accentDeep: string;
  /** Deepest accent — used sparingly for "midnight" treatments. */
  accentMidnight: string;
  /** Accent value chosen for text against the current theme's surface. */
  accentText: string;

  /** Positive state — green check, "live" status pill. */
  success: string;
  /** Negative state — destructive action confirmations, error states. */
  danger: string;
  /** Cautionary state — over-budget readings, degraded status. */
  warning: string;

  /**
   * Single "input" lightness for the dark ramp — surfaces below derive
   * from it via `hsl(... calc(var(--bg-l) ± n%))`. Emitted only when set;
   * concrete-surface themes leave it undefined.
   */
  bgL?: string;

  // Surfaces (low contrast → high contrast)
  bg: string;
  bgSunken: string;
  bgElev: string;
  bgApp: string;

  // Phone-frame bezel + inner ring.
  bezel: string;
  bezelInner: string;

  // Text (text + icon foreground). Roles, not arbitrary brightness rungs.
  text: string;
  textSoft: string;
  textFaint: string;
  textGhost: string;
  textInv: string;

  // Hairlines
  line: string;
  lineStrong: string;
  /** Modal and image-overlay veil. */
  scrim: string;

  // Shadows
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;

  /** Vertical "wall" gradient for the main pane and the bottom layer
   * of the device-wall composite. */
  bgWall: string;

  /** Signature backdrop behind any "device" surface — crosshatch over
   * `var(--bg-wall)`. Desktop-only. */
  deviceWall: string;

  // Sidebar surface — translucent + backdrop-blurred chrome introduced
  // in v0.5. Desktop-only (mobile has no sidebar shell).
  sidebarBg: string;
  sidebarBlur: string;
  sidebarDivider: string;

  /** App-icon palette — same hues across themes by design. */
  palette: Palette;
}

// Motion. One easing curve for the whole product: a calm, instrument-grade
// ease-out that both emitters publish as `--ease`. Shell and blueprint
// surfaces must not spell this role twice, so the literal lives here and
// nowhere else. It sits with the brand constants rather than in its own
// module because every extra module in this package widens the shell
// barrel's load graph (oxlint `no-barrel-file`).
export const EASE = "cubic-bezier(0.2, 0.7, 0.3, 1)";
