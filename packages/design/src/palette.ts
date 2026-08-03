// App identity palette — one hue per app, on one OKLCH wheel.
//
// The Binding Layer gives the shell no colour at all: every control is ink on
// paper. The point of that decision is that a hue on screen then PROVABLY
// belongs to an app, so the app hues have to be a system rather than eight
// hand-picked swatches. They are `oklch(0.50 0.09 <h>)` in light and
// `oklch(0.72 0.09 <h>)` in dark — one lightness and one chroma per theme,
// only the hue moves — which is what makes them equally loud, equally legible,
// and impossible for one app to out-shout another with.
//
// Resolved to sRGB hex HERE, at build time, not at render time: React Native
// has no `oklch()`, and the shell, the blueprint surface and the phone have to
// paint the same pixels. `oklchToHex` clamps chroma into gamut by bisection
// rather than clipping channels, so lightness and hue survive exactly.
//
// Key names are hue families, not app names: an app declares which hue it
// takes (see `apps.ts`), so re-pointing an app at another hue is a one-line
// change and never a palette rename. All eight names survived the flip, but
// three of them moved around the wheel to keep the names honest — `slate` sits
// at 255 (a muted blue) rather than at 320, which is a magenta no grey-blue
// name could describe.

import {
  AA_SOLVED_TEXT,
  composite,
  contrastRatio,
  parseColor,
  SELF_TINT,
  SOLVE_SURFACE,
  toHex,
  walkUntil,
} from "./color";
import type { SemanticRamp } from "./color";
import { oklchToHex } from "./oklab";

/** Lightness of the light-theme identity ring. */
const LIGHT_L = 0.5;
/** Lightness of the dark-theme identity ring. */
const DARK_L = 0.72;
/** The one chroma every identity hue is held to. A third-party hue is clamped
 *  to this before it is admitted, so no vendor can out-shout the system. */
export const IDENTITY_CHROMA = 0.09;

/** The hue wheel, in degrees. Claiming an app hue means claiming a key here. */
export const APP_HUES = {
  amber: 28,
  forest: 150,
  indigo: 290,
  ochre: 70,
  rose: 0,
  slate: 255,
  teal: 210,
  violet: 320,
} as const;

export type ColorKey = keyof typeof APP_HUES;
export type ColorHex = string;

const ring = (lightness: number): Record<ColorKey, string> =>
  Object.fromEntries(
    Object.entries(APP_HUES).map(([key, hue]) => [
      key,
      oklchToHex(lightness, IDENTITY_CHROMA, hue),
    ])
  ) as Record<ColorKey, string>;

/** The light-theme identity ring — the canonical `--c-<key>` value. */
export const palette: Record<ColorKey, string> = ring(LIGHT_L);

/** The dark-theme identity ring. Same hues, lifted so they read on near-black. */
export const paletteDark: Record<ColorKey, string> = ring(DARK_L);

export type Palette = typeof palette;

/** The identity ring one theme paints. */
export function paletteFor(kind: "light" | "dark"): Record<ColorKey, string> {
  return kind === "dark" ? paletteDark : palette;
}

// ── Palette hues as TEXT ───────────────────────────────────────────────────
//
// The eight `--c-*` hues are identity FILLS: an app icon container, a 2px rule
// beside an event, a content marker. Painted as `color:` they are a different
// job with a different floor — `oklch(0.72 …)` is a light rung and lands under
// 3:1 on a light surface — so each hue gets a solved TEXT rung beside its
// fill, walked along its own hue until it clears AA on the hardest surface it
// can land on AND on a 12% wash of itself. Every surface that wants a hue on
// type reads `--c-<name>-text`, never `--c-<name>`.

/** The palette hue `base` deepened (light) or lifted (dark) until it clears
 *  `AA_SOLVED_TEXT` on that theme's hardest surface under its own tint. The
 *  wash is of the BASE here (a chip is tinted with the fill, not with the ink),
 *  which is the one place this differs from `semanticShade`. */
function paletteTextShade(base: string, kind: SemanticRamp): string {
  const surface = toHex(
    composite(
      { alpha: SELF_TINT, rgb: parseColor(base).rgb },
      parseColor(SOLVE_SURFACE[kind]).rgb
    )
  );
  return walkUntil(
    base,
    (candidate) => contrastRatio(candidate, surface),
    AA_SOLVED_TEXT,
    kind === "light" ? -0.01 : 0.01
  );
}

function paletteTextShades(kind: SemanticRamp): Record<ColorKey, string> {
  return Object.fromEntries(
    Object.entries(paletteFor(kind)).map(([name, hex]) => [
      name,
      paletteTextShade(hex, kind),
    ])
  ) as Record<ColorKey, string>;
}

/**
 * Every palette hue as a legible `color:`, per theme — emitted as
 * `--c-<name>-text` by both emitters. A surface that needs a palette hue on
 * type reads this instead of `--c-<name>`.
 */
export const paletteText = {
  dark: paletteTextShades("dark"),
  light: paletteTextShades("light"),
} as const;
