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

import { palette } from "./palette";
import type { ColorKey } from "./palette";

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

/** Walk `base` along its own hue in 1-point lightness steps — `step` picks the
 *  direction — and return the FIRST shade whose `score` clears `floor`, i.e.
 *  the one closest to the owner's pick that the floor allows. Hue and
 *  saturation never move, so the result still reads as the same colour. */
function walkUntil(
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

/** `walkUntil` in the deepening direction — the light ramp's solver. */
function darkenUntil(
  base: string,
  score: (candidate: string) => number,
  floor: number = AA_BODY
): string {
  return walkUntil(base, score, floor, -0.01);
}

// ── Palette hues as TEXT ───────────────────────────────────────────────────
//
// The eight `--c-*` hues are documented as icon FILLS, and they are tuned for
// that: as `color:` on a near-white surface `--c-amber` is 2.3:1 and `--c-teal`
// 3.2:1. `--accent-text` exists because the accent had exactly this problem;
// the palette had no equivalent rung, so every surface that wanted a hue as
// text hand-picked a darker literal of its own (the `docs` file-kind tints did
// precisely that, and #686 removed those literals without noticing they were
// doing solved-contrast work). This is that missing rung, solved by the same
// machinery `--accent-text` uses, once per theme.

/**
 * The surface each theme's palette-text rung is solved against: the hardest
 * one either emitter ships. Light is the shell's `--bg-sunken` (`#F0F1F3`) —
 * the DARKEST light surface, so every lighter one gains. Dark is the blueprint
 * `--bg-sunken` at the default `--bg-l: 10%` (`hsl(171 11% 19%)`) — the
 * LIGHTEST dark surface, for the same reason in the other direction.
 */
const PALETTE_TEXT_SURFACE = {
  dark: "#2b3634",
  light: "#F0F1F3",
} as const;

/**
 * The same idea, per EMITTER × theme, for the semantic states below. The
 * palette rung can take one surface for both emitters because it is solved to
 * the union-hardest; the semantic states cannot, because the shell's darkest
 * ramp (`--bg-elev` at `--bg-l: 5%`) is far darker than the blueprint's
 * (`--bg-sunken` at `--bg-l: 10%`), and solving the shell against the
 * blueprint's surface walks `--danger` from a red to a washed pink (`#e2a6a6`)
 * to buy contrast it never needed. Each entry is the HARDEST surface that
 * emitter actually paints:
 *   - `shellLight`   `--bg-sunken` `#F0F1F3` — the darkest light surface.
 *   - `shellDark`    `--bg-elev` at `--bg-l: 5%` — the lightest dark one.
 *   - `blueprintLight` `--bg-sunken` at the hue that makes it darkest (237).
 *   - `blueprintDark`  `--bg-sunken` at the default hue, `--bg-l: 10%`.
 * A non-default `--app-hue` moves the blueprint surfaces by under 0.15 in
 * ratio, which is inside the 0.3 margin `AA_SOLVED_TEXT` already carries.
 */
const SEMANTIC_SURFACE = {
  blueprintDark: "#2b3634",
  blueprintLight: "#f1f1f6",
  shellDark: "#181818",
  shellLight: "#F0F1F3",
} as const;

/** Which emitter × theme a semantic state is being solved for. */
export type SemanticRamp = keyof typeof SEMANTIC_SURFACE;

/**
 * …plus a wash of the hue itself. A palette hue on type is almost never on a
 * bare surface: a coloured chip, badge, or thumbnail label sits on a weak tint
 * of its OWN hue, which has already walked the background toward the ink. So
 * the surface the rung is solved against is the hardest one WITH that wash on
 * it, and a bare surface is then strictly easier. 12% is the strength the tint
 * idiom uses (`tintBg()` in the `docs` app); it also moves the reference in the
 * harder direction for both themes — darker under light ink's opposite, lighter
 * under dark's — so it is a genuine worst case rather than an average.
 */
const SELF_TINT = 0.12;

/**
 * Floor the solved TEXT rungs — palette hues and semantic states alike — are
 * walked to. 0.3 above the 4.5 body floor for the same reason `AA_FILL` is:
 * the search walks 8-bit `hsl()` in 1-point steps, and that margin is what
 * keeps a rounding trip from shipping a 4.49.
 */
const AA_SOLVED_TEXT = 4.8;

/** The palette hue `base` deepened (light) or lifted (dark) until it clears
 *  `AA_PALETTE_TEXT` on that theme's hardest surface under its own tint. */
function paletteTextShade(base: string, kind: "light" | "dark"): string {
  const surface = toHex(
    composite(
      { alpha: SELF_TINT, rgb: parseColor(base).rgb },
      parseColor(PALETTE_TEXT_SURFACE[kind]).rgb
    )
  );
  return walkUntil(
    base,
    (candidate) => contrastRatio(candidate, surface),
    AA_SOLVED_TEXT,
    kind === "light" ? -0.01 : 0.01
  );
}

function paletteTextShades(kind: "light" | "dark"): Record<ColorKey, string> {
  return Object.fromEntries(
    Object.entries(palette).map(([name, hex]) => [
      name,
      paletteTextShade(hex, kind),
    ])
  ) as Record<ColorKey, string>;
}

/**
 * Every palette hue as a legible `color:`, per theme — emitted as
 * `--c-<name>-text` by both emitters. A surface that needs a palette hue on
 * type reads this instead of `--c-<name>`, exactly as it reads `--accent-text`
 * rather than `--accent`.
 */
export const paletteText = {
  dark: paletteTextShades("dark"),
  light: paletteTextShades("light"),
} as const;

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
  const bg = parseColor(SEMANTIC_SURFACE[ramp]).rgb;
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
    ramp.endsWith("Light") ? -0.01 : 0.01
  );
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
