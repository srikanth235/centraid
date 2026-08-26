// WCAG contrast math over token values: rungs are translucent, so a ratio only
// means something composited over the surface it lands on. Solved rungs stay in
// this file — a second module in the package index trips `no-barrel-file`.

export type Rgb = readonly [number, number, number];

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

/** Leading zero stripped: the Binding Layer spelling sheets are compared to. */
export function rgbaHex(hex: string, alpha: number): string {
  const { rgb } = parseColor(hex);
  return `rgba(${rgb.join(",")},${alpha.toString().replace(/^0(?=\.)/u, "")})`;
}

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

/** `background` must be opaque. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  const fg = composite(parseColor(foreground), bg.rgb);
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg.rgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Rungs below are walked, never hand-picked: a hand-picked rung lands under its
// floor silently (`--danger` at 3.74:1).

/** Hue and saturation never move; only lightness walks. */
export function walkUntil(
  base: string,
  score: (candidate: string) => number,
  floor: number,
  step: number
): string {
  const [h, s, l] = rgbToHsl(parseColor(base).rgb);
  const limit = step < 0 ? 0.05 : 0.95;
  for (
    let lightness = l;
    step < 0 ? lightness >= limit : lightness <= limit;
    lightness += step
  ) {
    const candidate = toHex(hslToRgb(h, s, lightness));
    if (score(candidate) >= floor) return candidate;
  }
  return toHex(hslToRgb(h, s, limit));
}

/** The hardest surface each theme paints ink on, so every other one gains. */
export const SOLVE_SURFACE = {
  dark: "#171716",
  light: "#F0EFED",
} as const;

export type SemanticRamp = keyof typeof SOLVE_SURFACE;

/** The tint idiom's strength: worst case in both themes, not an average. */
export const SELF_TINT = 0.12;

/** 0.3 above the 4.5 body floor: rounding margin for the 1-point walk. */
export const AA_SOLVED_TEXT = 4.8;

/** States are `color:` on small prose, so they owe the BODY floor. The wash is
 *  of the CANDIDATE, not the base: a chip tints with the shipped token. */
export function semanticShade(base: string, ramp: SemanticRamp): string {
  const bg = parseColor(SOLVE_SURFACE[ramp]).rgb;
  return walkUntil(
    base,
    (candidate) =>
      contrastRatio(
        candidate,
        toHex(
          composite({ alpha: SELF_TINT, rgb: parseColor(candidate).rgb }, bg)
        )
      ),
    AA_SOLVED_TEXT,
    ramp === "light" ? -0.01 : 0.01
  );
}
