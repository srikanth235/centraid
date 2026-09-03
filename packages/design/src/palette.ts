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

const LIGHT_L = 0.5;
const DARK_L = 0.72;
export const IDENTITY_CHROMA = 0.09;

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

export function clampIdentityHue(
  submitted: { hue: number; chroma?: number },
  scheme: "light" | "dark"
): ColorHex {
  const hue = ((submitted.hue % 360) + 360) % 360;
  const chroma = Math.min(
    Math.max(submitted.chroma ?? IDENTITY_CHROMA, 0),
    IDENTITY_CHROMA
  );
  const lightness = scheme === "dark" ? DARK_L : LIGHT_L;
  return oklchToHex(lightness, chroma, hue);
}

const ring = (lightness: number): Record<ColorKey, string> =>
  Object.fromEntries(
    Object.entries(APP_HUES).map(([key, hue]) => [
      key,
      oklchToHex(lightness, IDENTITY_CHROMA, hue),
    ])
  ) as Record<ColorKey, string>;

export const palette: Record<ColorKey, string> = ring(LIGHT_L);

export const paletteDark: Record<ColorKey, string> = ring(DARK_L);

export type Palette = typeof palette;

export function paletteFor(kind: "light" | "dark"): Record<ColorKey, string> {
  return kind === "dark" ? paletteDark : palette;
}

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

export const paletteText = {
  dark: paletteTextShades("dark"),
  light: paletteTextShades("light"),
} as const;
