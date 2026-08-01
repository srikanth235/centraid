// Centraid — WCAG contrast math over token values.
//
// Every token in this package is eventually painted as text or as a control
// edge, and the floors in WCAG 2.1 (4.5:1 for body text, 3:1 for large text
// and non-text UI) are the only objective test of whether a ramp is legible.
// The rungs are translucent, so a ratio is only meaningful once the value is
// composited over the specific surface it lands on — `--text-faint` clears AA
// on `--bg` and can still miss it on `--bg-sunken`.
//
// Kept dependency-free and shaped for the token vocabulary only: hex, `rgba()`
// and the space-separated `hsl()` the blueprint layer emits.
//
// The accent-ramp derivation below lives in this same module rather than its
// own file because it is the only consumer of the maths, and because the
// client's barrel sits at oxlint's `no-barrel-file` module cap — a second new
// module reachable from the package index trips that gate.

export type Rgb = readonly [number, number, number];

/** A parsed colour: opaque channels plus the alpha to composite them with. */
export interface ParsedColor {
  rgb: Rgb;
  alpha: number;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g] = [chroma, x];
  else if (hp < 2) [r, g] = [x, chroma];
  else if (hp < 3) [g, b] = [chroma, x];
  else if (hp < 4) [g, b] = [x, chroma];
  else if (hp < 5) [r, b] = [x, chroma];
  else [r, b] = [chroma, x];
  const m = l - chroma / 2;
  return [
    clampByte((r + m) * 255),
    clampByte((g + m) * 255),
    clampByte((b + m) * 255),
  ];
}

/** Inverse of `hslToRgb`, in the same 0–1 saturation/lightness units. */
export function rgbToHsl(rgb: Rgb): [number, number, number] {
  const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? 60 * (((g - b) / d) % 6)
      : max === g
        ? 60 * ((b - r) / d + 2)
        : 60 * ((r - g) / d + 4);
  return [h < 0 ? h + 360 : h, s, l];
}

export function toHex(rgb: Rgb): string {
  return (
    "#" + rgb.map((n) => clampByte(n).toString(16).padStart(2, "0")).join("")
  );
}

/** Parse the three colour spellings the token vocabulary uses. Throws on
 *  anything else — a token that cannot be measured must not silently pass. */
export function parseColor(value: string): ParsedColor {
  const raw = value.trim();

  const hex = /^#(?<digits>[\da-f]{6})$/iu.exec(raw)?.groups?.digits;
  if (hex !== undefined) {
    return {
      alpha: 1,
      rgb: [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ],
    };
  }

  const rgba = /^rgba?\((?<body>[^)]*)\)$/u.exec(raw)?.groups?.body;
  if (rgba !== undefined) {
    const parts = rgba.split(",").map((p) => p.trim());
    if (parts.length < 3) throw new Error(`unparseable colour: ${value}`);
    return {
      alpha: parts[3] === undefined ? 1 : Number(parts[3]),
      rgb: [Number(parts[0]), Number(parts[1]), Number(parts[2])],
    };
  }

  const hsl = /^hsla?\((?<body>[^)]*)\)$/u.exec(raw)?.groups?.body;
  if (hsl !== undefined) {
    // Space syntax with an optional `/ alpha`, which is what the blueprint
    // layer emits: `hsl(171 22% 13% / 0.13)`.
    const [channels = "", alphaPart] = hsl.split("/").map((p) => p.trim());
    const parts = channels.split(/[\s,]+/u).filter(Boolean);
    if (parts.length < 3) throw new Error(`unparseable colour: ${value}`);
    const h = Number(parts[0]);
    const s = Number((parts[1] ?? "").replace(/%$/u, "")) / 100;
    const l = Number((parts[2] ?? "").replace(/%$/u, "")) / 100;
    if ([h, s, l].some((n) => Number.isNaN(n))) {
      throw new Error(`unparseable colour: ${value}`);
    }
    return {
      alpha:
        alphaPart === undefined || alphaPart === "" ? 1 : Number(alphaPart),
      rgb: hslToRgb(h, s, l),
    };
  }

  throw new Error(`unparseable colour: ${value}`);
}

/** Flatten a translucent foreground onto an opaque background. */
export function composite(fg: ParsedColor, bg: Rgb): Rgb {
  return [
    fg.rgb[0] * fg.alpha + bg[0] * (1 - fg.alpha),
    fg.rgb[1] * fg.alpha + bg[1] * (1 - fg.alpha),
    fg.rgb[2] * fg.alpha + bg[2] * (1 - fg.alpha),
  ].map(clampByte) as unknown as Rgb;
}

export function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(rgb[0]) +
    0.7152 * channel(rgb[1]) +
    0.0722 * channel(rgb[2])
  );
}

/**
 * WCAG 2.1 contrast ratio of `foreground` against `background`. The
 * foreground is composited over the background first, so translucent rungs
 * are measured as they actually render. The background must be opaque.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  const fg = composite(parseColor(foreground), bg.rgb);
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg.rgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ── Accent ramps ───────────────────────────────────────────────────────────

export interface AccentRamp {
  /** The accent at full saturation — the FAB, focus rings, selection edges. */
  accent: string;
  /** Lighter tint for "new" badges, and the FILLED rung on the dark ramp,
   *  where the inverse ink is near-black and the fill has to be the light
   *  half of the pair. */
  light: string;
  /** The accent as a FILLED surface on the light ramp: solved so `--text-inv`
   *  clears AA on it (see `accentFillShade`). */
  deep: string;
  /** The accent as TEXT on a light surface. See `LIGHT_TEXT_SURFACE`. */
  text: string;
}

const LIGHT_SHIFT = 0.1;

/** The lightest surface an accent can be painted as text on (`--bg`). Text
 *  has to clear AA against it, so it is the one the shade is solved for. */
const LIGHT_TEXT_SURFACE = "#FCFCFC";
/** The ink a filled accent surface carries on the light ramp — `--text-inv`,
 *  which is a near-white, not pure white. Solving the fill against the ink
 *  that actually lands on it (rather than against `#fff`) is the difference
 *  between a button that measures 4.9:1 and one that measures 4.5:1. */
const LIGHT_INVERSE_INK = "#F4F5F7";
const AA_BODY = 4.5;
/** Floor the FILL is solved to. Deliberately 0.3 above the 4.5 body floor:
 *  the search walks lightness in 1-point steps through 8-bit `hsl()`, so the
 *  margin is what keeps a rounding trip from landing a shipped fill at 4.49. */
const AA_FILL = 4.8;

function shiftLightness(base: string, delta: number): string {
  const [h, s, l] = rgbToHsl(parseColor(base).rgb);
  return toHex(hslToRgb(h, s, Math.max(0, Math.min(1, l + delta))));
}

/**
 * Darken `base` until it clears AA as body text on a light surface. A
 * saturated mid-lightness accent (BRAND is 2.0:1 on `--bg`) is illegible as a
 * link, so every accent needs this shade before it can be assigned to
 * `color:`.
 */
function accentTextShade(base: string): string {
  return darkenUntil(base, (candidate) =>
    contrastRatio(candidate, LIGHT_TEXT_SURFACE)
  );
}

/**
 * Darken `base` until `--text-inv` clears AA **on** it — the fill counterpart
 * of `accentTextShade`. The filled primary button is the one place the accent
 * carries text, and a mid-lightness accent cannot carry any fixed ink: BRAND
 * is 2.07:1 under white, and an app that retunes the accent to `--c-amber`
 * lands even lighter. Deepening the FILL is the only lever that works for
 * every hue, because CSS has no shipped way to pick the ink per background
 * (`color-contrast()` is still unimplemented).
 */
function accentFillShade(base: string): string {
  return darkenUntil(
    base,
    (candidate) => contrastRatio(LIGHT_INVERSE_INK, candidate),
    AA_FILL
  );
}

/** Walk `base` down its own hue in 1-point lightness steps and return the
 *  FIRST (lightest) shade whose `score` clears `floor` — staying as close to
 *  the owner's pick as the floor allows. */
function darkenUntil(
  base: string,
  score: (candidate: string) => number,
  floor: number = AA_BODY
): string {
  const [h, s, l] = rgbToHsl(parseColor(base).rgb);
  for (let lightness = l; lightness >= 0.05; lightness -= 0.01) {
    const candidate = toHex(hslToRgb(h, s, lightness));
    if (score(candidate) >= floor) return candidate;
  }
  return toHex(hslToRgb(h, s, 0.05));
}

/** Derive the full four-value ramp for an accent base colour. */
export function accentRamp(base: string): AccentRamp {
  return {
    accent: base,
    deep: accentFillShade(base),
    light: shiftLightness(base, LIGHT_SHIFT),
    text: accentTextShade(base),
  };
}
