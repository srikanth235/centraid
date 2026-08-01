// Centraid — Theme interface + shared constants.
// Each preset under this folder builds a `Theme` literal; the
// `themes/index.ts` barrel collects them into a typed registry.

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
export const ACCENT_DEEP = "#2AA593";
export const ACCENT_MIDNIGHT = "#12645A";

// BRAND as TEXT. It is legible as a button face with white on it, and as text
// on the dark ramp (9.4:1), but on a near-white surface it lands at 2.0:1 —
// below the floor for text at any size. Every `color: var(--accent-text)` site
// reads this instead, so a light surface gets a deepened teal that still reads
// as the brand hue (5.1:1 on `--bg`). Fills and focus rings keep `--accent`.
export const ACCENT_TEXT_LIGHT = "#0F7A6C";

// SUCCESS is tuned for the dark ramp (4.8:1 there). On near-white it is 3.9:1
// — fine for a status dot, short of AA for the label beside it, so the light
// theme carries a deepened leaf of the same hue (6.0:1). DANGER clears AA on
// both ramps as-is and is shared.
export const SUCCESS = "#5C8A4E";
export const SUCCESS_LIGHT = "#456B39";
export const DANGER = "#C44A4A";

// Warning. The kit and the client both painted `var(--warn)` — a name no
// emitter ever defined, so those rules resolved to nothing (#672). The role is
// real, so it becomes a contract token under the same spelling the app surface
// already used: `--warning`. Amber is the hue; each ramp takes the lightness
// that clears AA on its own surfaces (4.6:1 light, 9.2:1 dark).
export const WARNING = "#E0A94A";
export const WARNING_LIGHT = "#9A6B1F";

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
