// oklab colour maths shared by the contrast grids.
//
// The accent and state ramps are `color-mix()` over a runtime hue, so a test
// that only understands `hsl()` cannot see them — which is exactly how
// `--accent-deep` shipped at 3.04:1 under its own ink. This is the browser's
// oklab mix, extracted from `contrast.test.ts` so both that file and its
// callers stay under the file-size limit.

import { parseColor, rgbToHsl, SELF_TINT, toHex } from "./color.js";

type Triple = [number, number, number];

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

function rgbToOklab(value: string): Triple {
  const [r, g, b] = parseColor(value).rgb.map((n) => toLinear(n / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(lab: Triple): string {
  const rgb = oklabToLinearRgb(lab).map((c) =>
    Math.max(0, Math.min(255, toGamma(c) * 255))
  );
  return toHex([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]);
}

/** Linear-light sRGB triple for one oklab colour, BEFORE gamut clamping. */
function oklabToLinearRgb([L, a, b]: Triple): Triple {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const IN_GAMUT_EPSILON = 0.000_01;

const inGamut = (rgb: Triple): boolean =>
  rgb.every(
    (channel) => channel >= -IN_GAMUT_EPSILON && channel <= 1 + IN_GAMUT_EPSILON
  );

/**
 * `oklch(<l> <c> <h>)` resolved to an sRGB hex at BUILD TIME.
 *
 * React Native has no `oklch()` and no `color-mix()`, and the shell must paint
 * the same pixels as the app surface, so an identity hue may never reach a
 * renderer as a colour function. The one subtlety is gamut: `oklch(0.5 0.09 h)`
 * is inside sRGB at every hue this package ships, but a caller can ask for a
 * chroma that is not, and naively clipping the channels shifts the HUE (the
 * clipped channel moves the colour sideways, not just inward). So chroma is
 * bisected down to the largest value that still lands in gamut, which keeps
 * lightness and hue exact — the two properties the app palette is defined by.
 */
export function oklchToHex(
  lightness: number,
  chroma: number,
  hue: number
): string {
  const radians = (hue * Math.PI) / 180;
  const at = (c: number): Triple =>
    oklabToLinearRgb([lightness, c * Math.cos(radians), c * Math.sin(radians)]);

  let usable = chroma;
  if (!inGamut(at(chroma))) {
    let low = 0;
    let high = chroma;
    // 24 halvings resolve chroma far finer than the 1/255 the hex can carry.
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2;
      if (inGamut(at(mid))) low = mid;
      else high = mid;
    }
    usable = low;
  }

  const rgb = at(usable).map((channel) =>
    Math.max(0, Math.min(255, toGamma(Math.max(0, Math.min(1, channel))) * 255))
  );
  return toHex([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]);
}

/** Split on the top-level (paren-depth 0) commas of a function's argument
 *  list — `hsl(a, b, c)` nested inside a mix must survive intact. */
function topLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim());
}

/** Evaluate every `color-mix(in oklab, A p%, B)` in `value`, innermost first,
 *  the way a browser composites it. Only the oklab form is supported — it is
 *  the only one this package emits, and an unrecognised space must not be
 *  silently averaged in the wrong one. */
export function evalColorMix(value: string): string {
  let out = value;
  for (;;) {
    const open = out.lastIndexOf("color-mix(");
    if (open < 0) return out;
    let depth = 0;
    let close = -1;
    for (let i = open + "color-mix".length; i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error(`unbalanced color-mix in: ${value}`);
    const args = topLevelArgs(out.slice(open + "color-mix(".length, close));
    const [space, first, second] = args;
    if (space?.trim() !== "in oklab" || !first || !second) {
      throw new Error(`unsupported color-mix: ${out.slice(open, close + 1)}`);
    }
    const share = /^(?<color>.+?)\s+(?<pct>[\d.]+)%$/u.exec(first);
    if (!share?.groups)
      throw new Error(`color-mix needs a percentage: ${first}`);
    const p = Number(share.groups.pct) / 100;
    const a = rgbToOklab(share.groups.color ?? "");
    const b = rgbToOklab(second);
    const mixed = oklabToHex([
      (a[0] ?? 0) * p + (b[0] ?? 0) * (1 - p),
      (a[1] ?? 0) * p + (b[1] ?? 0) * (1 - p),
      (a[2] ?? 0) * p + (b[2] ?? 0) * (1 - p),
    ]);
    out = out.slice(0, open) + mixed + out.slice(close + 1);
  }
}

/** Perceptual distance in oklab — the space the mixes are already done in,
 *  and the only one where "these two look the same" is a number. */
export function oklabDistance(a: string, b: string): number {
  const [al, aa, ab] = rgbToOklab(a);
  const [bl, ba, bb] = rgbToOklab(b);
  return Math.hypot(al - bl, aa - ba, ab - bb);
}

/** `color-mix(in oklab, C p%, transparent)` composited over `bg` — the alpha
 *  blend a browser performs for every hue-wash chip in the tree. Separate from
 *  `evalColorMix` because the second operand there is a colour, not the
 *  surface the mix ends up painted on. */
export function alphaOver(color: string, bg: string, share: number): string {
  const fg = parseColor(color).rgb;
  const back = parseColor(bg).rgb;
  return toHex(
    [0, 1, 2].map(
      (i) => (fg[i] ?? 0) * share + (back[i] ?? 0) * (1 - share)
    ) as unknown as [number, number, number]
  );
}

/** Substitute the knobs the token CSS parameterizes colours by, so an
 *  `hsl(0 0% calc(var(--bg-l) + 4.5%))` becomes a measurable colour. This is
 *  CSS measurement machinery; React Native receives already-concrete values
 *  from `toNativeTheme()` and never parses this syntax. */
export function resolveVars(
  value: string,
  scope: Record<string, string>
): string {
  return value
    .replace(
      /var\((?<name>--[\w-]+)\)/gu,
      (whole: string, name: string) => scope[name] ?? whole
    )
    .replace(
      /calc\(\s*(?<a>[\d.]+)%\s*(?<op>[+-])\s*(?<b>[\d.]+)%\s*\)/gu,
      (_whole: string, a: string, op: string, b: string) =>
        `${op === "+" ? Number(a) + Number(b) : Number(a) - Number(b)}%`
    );
}

// Emitted-CSS readers: pull a selector's declarations out of a generated
// stylesheet and resolve a value's var() references within that scope.
export function declarations(
  css: string,
  selector: string
): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in the emitted CSS`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const m = /^\s*(?<name>--[\w-]+)\s*:\s*(?<value>.+?);\s*$/u.exec(line);
    if (m?.groups?.name && m.groups.value) out[m.groups.name] = m.groups.value;
  }
  return out;
}

// ── Semantic states ────────────────────────────────────────────────────────
/** The three state roles, in the order the separation check reports them. */
export const SEMANTIC_STATES = ["--danger", "--success", "--warning"] as const;
export { SELF_TINT } from "./color.js";
/** Past this a state has stopped being its hue and become near-black (light)
 *  or near-white (dark). Same guard the accent fills carry. */
export const RECOGNISABLE_STATE = 12;
/** …and the other way a solve can cheat: desaturate. A grey clears every
 *  contrast floor on every surface and stays 0.06 from its neighbours in
 *  oklab, and codes nothing — "this is an error" has to be legible as RED, not
 *  just legible. So each role is held to its hue family and to real chroma.
 *  Bands are wide (they are a sanity check, not a tuning knob) but they are
 *  closed: nothing outside them can be the role. */
export const STATE_HUE = {
  // Red, wrapping 0.
  "--danger": [340, 20],
  // Green.
  "--success": [70, 160],
  // Amber/ochre.
  "--warning": [20, 60],
} as const;
export const MIN_STATE_SATURATION = 0.2;

/** True while `value` still reads as `role`'s colour: right hue family, and
 *  saturated enough to be a hue at all rather than a grey. */
export function readsAsRole(
  value: string,
  role: keyof typeof STATE_HUE
): boolean {
  const [hue, sat] = rgbToHsl(parseColor(value).rgb);
  const [lo, hi] = STATE_HUE[role];
  const inBand = lo > hi ? hue >= lo || hue <= hi : hue >= lo && hue <= hi;
  return inBand && sat >= MIN_STATE_SATURATION;
}

/** `color-mix(in oklab, C 12%, transparent)` over `bg` — the alpha composite a
 *  browser performs for a state-tinted chip. */
export function selfTint(value: string, bg: string): string {
  const fg = parseColor(value).rgb;
  const back = parseColor(bg).rgb;
  return toHex(
    [0, 1, 2].map((i) => {
      const a = fg[i] ?? 0;
      const b = back[i] ?? 0;
      return a * SELF_TINT + b * (1 - SELF_TINT);
    }) as unknown as [number, number, number]
  );
}
