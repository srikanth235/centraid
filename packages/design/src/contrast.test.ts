// WCAG floors for every ramp this package ships, measured against the actual
// EMITTED CSS rather than against literals copied out of it — a test that
// re-types the values it is guarding stops tracking them the moment someone
// edits the source.
//
// Floors (WCAG 2.1): 4.5:1 for body text (1.4.3), 3:1 for large text and
// non-text UI such as borders and icons (1.4.11). Each rung is measured on
// every surface it can land on, because a translucent rung that clears AA on
// `--bg` can still miss it on the sunken track.

import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { contrastRatio, parseColor, rgbToHsl, toHex } from "./color.js";
import { toCss } from "./css.js";
import { palette } from "./palette.js";
import { BRAND } from "./themes/shared.js";

const AA_BODY = 4.5;
const AA_LARGE = 3;

/** The floor each role has to clear, given the job it is assigned. */
const TEXT_FLOORS = {
  "--text": AA_BODY,
  "--text-soft": AA_BODY,
  // Captions and metadata rows — still prose, still body-sized.
  "--text-faint": AA_BODY,
  // Placeholders, disabled glyphs, hairline icons. Never body copy.
  "--text-ghost": AA_LARGE,
} as const;

/** Parse the `--name: value;` pairs out of one `{ … }` block. */
function declarations(css: string, selector: string): Record<string, string> {
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

/** Substitute the knobs the token CSS parameterizes colours by, so an
 *  `hsl(var(--app-hue) 8% 42%)` becomes a measurable colour, then evaluate the
 *  one `calc()` form in use. Mirrors what `apps/mobile/src/kit/theme/
 *  generate.ts` does when it lowers the same CSS for React Native. */
function resolve(value: string, scope: Record<string, string>): string {
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

// ── color-mix(in oklab, …) ─────────────────────────────────────────────────
// The accent fills are `color-mix()` over a runtime hue, so a test that only
// understands `hsl()` cannot see them — which is exactly how `--accent-deep`
// shipped at 3.04:1 under its own ink. This is the browser's oklab mix, small
// enough to keep beside the assertions that depend on it.

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

function oklabToHex([L, a, b]: Triple): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.max(0, Math.min(255, toGamma(c) * 255)));
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
function evalColorMix(value: string): string {
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

function measurable(value: string): boolean {
  return (
    /^(?<colour>#|rgba?\(|hsla?\()/u.test(value.trim()) &&
    !value.includes("var(")
  );
}

/** Ratios of a ramp's rungs against one surface, in declaration order. */
function ramp(
  tokens: Record<string, string>,
  names: readonly string[],
  surface: string,
  scope: Record<string, string>
): number[] {
  return names.map((name) =>
    contrastRatio(resolve(tokens[name] ?? "", scope), surface)
  );
}

describe("shell token contrast floors", () => {
  const css = toCss();
  const light = declarations(css, ":root");
  const dark = { ...light, ...declarations(css, "[data-theme='dark']") };

  // Every opaque surface a foreground can be painted on. The dark ramp derives
  // from `--bg-l`, which only the browser resolves, so it is substituted with
  // the lightness the shipped dark theme declares.
  const SURFACE_NAMES = ["--bg", "--bg-app", "--bg-elev", "--bg-sunken"];

  describe.each([
    ["light", light, {}],
    ["dark", dark, { "--bg-l": "5%" }],
  ] as const)("%s", (name, tokens, scope) => {
    const surfaces = SURFACE_NAMES.map((key) =>
      resolve(tokens[key] ?? "", scope)
    ).filter(measurable);

    test(`${name}: every surface resolves to a measurable colour`, () => {
      expect(surfaces).toHaveLength(SURFACE_NAMES.length);
    });

    test(`${name}: text roles clear their floor on every surface`, () => {
      for (const [token, floor] of Object.entries(TEXT_FLOORS)) {
        const value = tokens[token];
        expect(value, `${name} ${token} is emitted`).toBeDefined();
        for (const surface of surfaces) {
          expect(
            contrastRatio(resolve(value ?? "", scope), surface),
            `${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(floor);
        }
      }
    });

    test(`${name}: the text ramp stays ordered`, () => {
      // Without this, raising a failing rung until it passes could flatten the
      // ramp into four indistinguishable greys that all clear their floor.
      const ratios = ramp(
        tokens,
        Object.keys(TEXT_FLOORS),
        surfaces[0] ?? "",
        scope
      );
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1] ?? 0,
          `${name} rung ${i} is not above rung ${i + 1}`
        ).toBeGreaterThan(ratios[i] ?? 0);
      }
    });

    test(`${name}: the filled accent rung carries --text-inv`, () => {
      // `.kit-btn.primary` in the shell. The two ramps take opposite halves of
      // the pair — deep fill under near-white ink on light, lifted fill under
      // near-black ink on dark — so this is measured per theme, not once.
      const fill = resolve(tokens["--accent-deep"] ?? "", scope);
      const ink = resolve(tokens["--text-inv"] ?? "", scope);
      expect(contrastRatio(ink, fill), `${name} fill`).toBeGreaterThanOrEqual(
        AA_BODY
      );
      // The hover fill steps 12% toward `--text`, away from the ink.
      const hover = evalColorMix(
        `color-mix(in oklab, ${fill} 88%, ${resolve(
          tokens["--text"] ?? "",
          scope
        )})`
      );
      expect(contrastRatio(ink, hover), `${name} hover`).toBeGreaterThanOrEqual(
        contrastRatio(ink, fill)
      );
      // `--on-accent` is a DIFFERENT role (saturated fills, scrims) and the
      // shell never emitted it, so five `var(--on-accent)` rules in the client
      // silently inherited their surroundings.
      expect(tokens["--on-accent"], `${name} --on-accent`).toBeDefined();
    });

    test(`${name}: accent and status colours are legible as text`, () => {
      const bg = surfaces[0] ?? "";
      // `--accent-text` exists precisely so the accent can be a `color:`.
      expect(
        contrastRatio(resolve(tokens["--accent-text"] ?? "", scope), bg),
        `${name} --accent-text`
      ).toBeGreaterThanOrEqual(AA_BODY);
      for (const token of ["--success", "--danger", "--warning"]) {
        expect(
          contrastRatio(resolve(tokens[token] ?? "", scope), bg),
          `${name} ${token}`
        ).toBeGreaterThanOrEqual(AA_LARGE);
      }
    });
  });
});

describe("blueprint token contrast floors", () => {
  const css = toBlueprintCss();
  const light = declarations(css, ":root");
  const dark = { ...light, ...declarations(css, ":root[data-theme='dark']") };

  // The app surface is hue-parameterized; an app overrides `--app-hue` for its
  // own identity, so the floors are asserted on the shipped default (BRAND's
  // hue) — what every app that sets no identity actually renders.
  const HUE = "171";
  // The app layer has no `--text-ghost`; its ramp stops at faint.
  const ROLES = ["--text", "--text-soft", "--text-faint"];

  describe.each([
    ["light", light, {}],
    ["dark", dark, { "--bg-l": "10%" }],
  ] as const)("%s", (name, tokens, extra) => {
    const scope = { "--app-hue": HUE, ...extra };
    // Dark `--bg` is `var(--bg-wall)`, which the host supplies at runtime, so
    // the measurable app surfaces are the card and the recessed track.
    const surfaces = ["--bg-elev", "--bg-sunken"]
      .map((key) => resolve(tokens[key] ?? "", scope))
      .filter(measurable);

    test(`${name}: app-surface text roles clear AA on card and track`, () => {
      expect(surfaces).toHaveLength(2);
      for (const token of ROLES) {
        for (const surface of surfaces) {
          expect(
            contrastRatio(resolve(tokens[token] ?? "", scope), surface),
            `blueprint ${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    });

    test(`${name}: the app-surface text ramp stays ordered`, () => {
      const ratios = ramp(tokens, ROLES, surfaces[0] ?? "", scope);
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1] ?? 0,
          `blueprint ${name} rung ${i} is not above rung ${i + 1}`
        ).toBeGreaterThan(ratios[i] ?? 0);
      }
    });
  });

  // ── The filled primary button, across every accent an app can claim ──────
  //
  // `.kit-btn.primary` paints `--accent-deep` under `--text-inv`, and an app
  // moves `--accent`/`--app-color` to any of the eight palette hues. One fixed
  // ink cannot serve all of them (amber wants dark ink, violet wants light),
  // and CSS has no shipped way to choose one — so the FILL is solved instead,
  // per theme, and this grid is the proof. Both rungs shipped below AA before
  // #686 F3: 3.16:1 light, 1.98:1 dark at the worst hue.
  describe("the filled accent rung carries its ink at every hue", () => {
    const ACCENTS = { ...palette, "brand (shell accent)": BRAND };
    const AA_HOVER_FLOOR = AA_BODY;
    // Above 11:1 the fill has stopped reading as its hue and started reading
    // as black — the failure mode of "just darken it until it passes".
    const RECOGNISABLE = 11;

    /** The `--app-hue` an app running this accent would declare. */
    const hueOf = (hex: string): string =>
      String(Math.round(rgbToHsl(parseColor(hex).rgb)[0]));

    describe.each([
      ["light", light, {}],
      ["dark", dark, { "--bg-l": "10%" }],
    ] as const)("%s", (theme, tokens, extra) => {
      test.each(Object.entries(ACCENTS))(`${theme}: %s`, (_name, accentHex) => {
        const scope = {
          "--app-hue": hueOf(accentHex),
          "--_accent": accentHex,
          ...extra,
        };
        const fill = evalColorMix(
          resolve(tokens["--accent-deep"] ?? "", scope)
        );
        const ink = evalColorMix(resolve(tokens["--text-inv"] ?? "", scope));
        // `.kit-btn.primary:hover` — the fill stepped toward `--text`, i.e.
        // away from the ink. Kept in step with kit/kit.css by hand; the
        // point of measuring it is that a hover MUST NOT undo the fix.
        const hover = evalColorMix(
          `color-mix(in oklab, ${fill} 88%, ${evalColorMix(
            resolve(tokens["--text"] ?? "", scope)
          )})`
        );

        expect(contrastRatio(ink, fill), "rest").toBeGreaterThanOrEqual(
          AA_BODY
        );
        expect(contrastRatio(ink, hover), "hover").toBeGreaterThanOrEqual(
          AA_HOVER_FLOOR
        );
        // Hover moves away from the ink, never toward it.
        expect(contrastRatio(ink, hover)).toBeGreaterThanOrEqual(
          contrastRatio(ink, fill)
        );
        expect(contrastRatio(ink, fill), "still reads as its hue").toBeLessThan(
          RECOGNISABLE
        );
        // And the button has to be findable on the surface behind it.
        const card = evalColorMix(resolve(tokens["--bg-elev"] ?? "", scope));
        expect(
          contrastRatio(fill, card),
          "fill vs card"
        ).toBeGreaterThanOrEqual(AA_LARGE);
      });
    });
  });

  test("the default app hue is the brand hue", () => {
    // 222 (ink-blue) was the pre-teal default; it tinted every unbranded app's
    // greys, ink and shadows toward a second, competing brand.
    expect(light["--app-hue"]).toBe(HUE);
  });
});
