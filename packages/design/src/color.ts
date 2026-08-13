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
// The solved-rung derivation below lives in this same module rather than its
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

/**
 * A hex at an alpha, as `rgba()`.
 *
 * This is the one place a WASH is built from an opaque rung, so a tint of a
 * role can never drift from the role it tints: change `NET` and `--net-wash`
 * moves with it. The leading zero of the alpha is stripped to match the
 * Binding Layer's own spelling (`rgba(154,59,46,.07)`), which is what the
 * emitted sheets are compared against.
 */
export function rgbaHex(hex: string, alpha: number): string {
  const { rgb } = parseColor(hex);
  return `rgba(${rgb.join(",")},${alpha.toString().replace(/^0(?=\.)/u, "")})`;
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

// ── Solved rungs ───────────────────────────────────────────────────────────
//
// The Binding Layer retired the multi-accent machinery: there is no accent hue
// to derive a ramp from, because the accent IS the ink. What survives is the
// solver — the walk that moves a colour along its OWN hue until it clears a
// floor — because the palette-text rungs and the semantic states still need
// it, and hand-picking them is how `--danger` shipped at 3.74:1 once already.

/** Walk `base` along its own hue in 1-point lightness steps — `step` picks the
 *  direction — and return the FIRST shade whose `score` clears `floor`, i.e.
 *  the one closest to the authored pick that the floor allows. Hue and
 *  saturation never move, so the result still reads as the same colour. */
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

/**
 * The surface every solved rung is scored against: the HARDEST one the system
 * paints ink on in that theme. Light is `WALL` (`#F0EFED`) — the deepest
 * paper the system paints, deeper than the page or any raised surface, so
 * every lighter surface gains. Dark is the raised paper (`#171716`) — the
 * LIGHTEST dark surface, for the same reason in the other direction. Both
 * emitters now share one surface ramp, so one pair covers the shell, the
 * blueprint layer and native alike.
 */
export const SOLVE_SURFACE = {
  dark: "#171716",
  light: "#F0EFED",
} as const;

/** Which theme a solved rung is being walked for. */
export type SemanticRamp = keyof typeof SOLVE_SURFACE;

/**
 * A state on type is usually on a weak tint of ITSELF — `color-mix(in oklab,
 * var(--danger) 12%, transparent)` chips are the single largest bucket of
 * `--danger` sites — so the surface a walk is scored against carries that
 * wash. 12% is the strength the tint idiom uses, and it moves the reference in
 * the harder direction for both themes, so it is a genuine worst case rather
 * than an average.
 */
export const SELF_TINT = 0.12;

/**
 * Floor the solved TEXT rungs — palette hues and semantic states alike — are
 * walked to. 0.3 above the 4.5 body floor because the search walks 8-bit
 * `hsl()` in 1-point steps, and that margin is what keeps a rounding trip from
 * shipping a 4.49.
 */
export const AA_SOLVED_TEXT = 4.8;

// ── Semantic states as TEXT ────────────────────────────────────────────────
//
// `--danger` / `--success` / `--warning` are documented as states, but what
// they overwhelmingly ARE in this repo is `color:` on small prose: 100
// `color: var(--danger)` rules, 23 `--success`, 8 `--warning`, essentially all
// of them between 9px and 13.7px — under every large-text exemption. They were
// hand-picked rather than solved, and nothing pinned them: `contrast.test.ts`
// measured the three roles at the 3:1 NON-TEXT floor, on `--bg` only. Measured
// against the emitted CSS, the shipped picks missed the body floor on the
// surfaces they actually land on — shell `--danger` at 3.74:1 on dark
// `--bg-elev`, blueprint `--danger` at 3.98:1 on the dark track — while the
// root DESIGN.md claimed "clears AA on both ramps".
//
// Same machinery as the palette rung, and for the same reason: a state on type
// is usually on a weak tint of ITSELF (`color-mix(in oklab, var(--danger) 12%,
// transparent)` chips are the single largest bucket of `--danger` sites), so
// the surface the walk is scored against carries that wash. Unlike the palette
// rung the wash is of the CANDIDATE, not of the base — a `color-mix()` chip
// tints with the shipped token, so a rung solved against the base's tint ships
// a surface that has moved with it and lands ~0.5 short.

/**
 * `base` deepened (light ramps) or lifted (dark ramps) until it clears
 * `AA_SOLVED_TEXT` on that emitter's hardest surface AND on a `SELF_TINT` wash
 * of itself over that surface. Lightness only — hue and saturation never move,
 * so red stays red and the three states stay tellable apart.
 */
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
