// Centraid — Theme interface + shared constants.
// Each preset under this folder builds a `Theme` literal; the
// `themes/index.ts` barrel collects them into a typed registry.

import type { Palette } from '../palette';

// Brand teal — the single source of truth for the Centraid identity.
// This is the exact hue used by the logo + app-icon marks; the SVG
// assets under `assets/` and `docs/assets/` hardcode this same hex, and
// `toCss()` emits it as a theme-independent `--brand` var.
export const BRAND = '#3EC8B4';

// Teal accent ramp derived from BRAND. Used for the FAB, sparkle button,
// primary CTAs, brand mark, focus rings, and active state in version
// history. Only Centraid's own light/dark themes read these — the
// emulation presets (Notion, GitHub, …) define their own accents inline.
// The base accent is BRAND itself (see above); the ramp extends from it.
export const ACCENT_LIGHT = '#62D6C6';
export const ACCENT_DEEP = '#2AA593';
export const ACCENT_MIDNIGHT = '#12645A';
export const ACCENT_VIOLET = '#7C5BD9';

export const SUCCESS = '#5C8A4E';
export const DANGER = '#C44A4A';

// Mobile phones have dark bezels regardless of UI theme — keep the
// phone-frame chrome constant across every preset.
export const BEZEL = '#0a0d13';
export const BEZEL_INNER = '#14181F';

export interface Theme {
  /** Light vs dark family — drives the picker grouping and the
   * applicability of dark-only tuning knobs (cool-blue-cast, --bg-l). */
  kind: 'light' | 'dark';

  /** Single brand accent — FAB, sparkle, primary CTAs, focus rings. */
  accent: string;
  /** Lighter accent for "new" badges / hovered active rows. */
  accentLight: string;
  /** Darker accent for pressed states / depth. */
  accentDeep: string;
  /** Deepest accent — used sparingly for "midnight" treatments. */
  accentMidnight: string;
  /** Cool-violet sub-accent. Used as the legacy "Centraid purple". */
  accentViolet: string;

  /** Positive state — green check, "live" status pill. */
  success: string;
  /** Negative state — destructive action confirmations, error states. */
  danger: string;

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

  // Ink (text + icon foreground)
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  inkInv: string;

  // Hairlines
  line: string;
  lineStrong: string;

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
