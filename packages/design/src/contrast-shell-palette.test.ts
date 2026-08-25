// Palette hues as TEXT on the SHELL's surfaces (#686). `contrast.test.ts`
// pins `--c-*-text` off `toBlueprintCss()` (`--bg-l: 10%`); the shell
// emitter ramps at `--bg-l: 5%` with two more surfaces.

import { describe, expect, test } from "vitest";

import { contrastRatio, parseColor, rgbToHsl } from "./color.js";
import { toCss } from "./css.js";
import {
  alphaOver,
  declarations,
  evalColorMix,
  oklabDistance,
  resolveVars,
} from "./oklab.js";
import { palette, paletteDark } from "./palette.js";

const AA_BODY = 4.5;

const SURFACE_NAMES = ["--bg", "--bg-app", "--bg-elev", "--bg-sunken"] as const;

/** Past 16% spends contrast the solve did not buy. */
const WASHES = [0.06, 0.07, 0.08, 0.1, 0.12, 0.14, 0.16] as const;

/** Past this a rung has become near-black/near-white — "darken until it passes". */
const RECOGNISABLE = 12;

describe("palette-hue-as-text on the shell surfaces", () => {
  const css = toCss();
  const light = declarations(css, ":root");
  const dark = { ...light, ...declarations(css, "[data-theme='dark']") };

  describe.each([
    ["light", light, palette],
    ["dark", dark, paletteDark],
  ] as const)("%s", (theme, tokens, ring) => {
    const scope = {};
    const surfaces = SURFACE_NAMES.map((key) =>
      evalColorMix(resolveVars(tokens[key] ?? "", scope))
    );

    test(`${theme}: every shell surface resolves to a measurable colour`, () => {
      expect(surfaces).toHaveLength(SURFACE_NAMES.length);
      for (const surface of surfaces) {
        expect(surface, `${theme} surface`).toMatch(/^(?:#|rgba?\(|hsla?\()/u);
        expect(surface, `${theme} surface`).not.toContain("var(");
      }
    });

    test.each(Object.entries(ring))(
      `${theme}: --c-%s-text clears AA bare and on every wash the shell paints`,
      (name, fillHex) => {
        const declared = tokens[`--c-${name}-text`];
        expect(declared, `--c-${name}-text is emitted`).toBeDefined();
        const ink = evalColorMix(resolveVars(declared ?? "", scope));
        for (const surface of surfaces) {
          expect(
            contrastRatio(ink, surface),
            `${theme} --c-${name}-text on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
          for (const share of WASHES) {
            expect(
              contrastRatio(ink, alphaOver(fillHex, surface, share)),
              `${theme} --c-${name}-text on a ${share * 100}% wash of its own fill over ${surface}`
            ).toBeGreaterThanOrEqual(AA_BODY);
          }
        }
        expect(
          Math.max(...surfaces.map((s) => contrastRatio(ink, s))),
          `${theme} --c-${name}-text still reads as its hue`
        ).toBeLessThan(RECOGNISABLE);
      }
    );

    test(`${theme}: the rung is its fill's hue, moved only in lightness`, () => {
      // Desaturating to pass would converge eight hues on one grey.
      for (const [name, fillHex] of Object.entries(ring)) {
        const ink = evalColorMix(
          resolveVars(tokens[`--c-${name}-text`] ?? "", scope)
        );
        const [fillHue, fillSat, fillLight] = rgbToHsl(parseColor(fillHex).rgb);
        const [hue, sat, lightness] = rgbToHsl(parseColor(ink).rgb);
        expect(
          Math.abs(hue - fillHue),
          `${theme} --c-${name}-text hue`
        ).toBeLessThan(2);
        expect(
          Math.abs(sat - fillSat),
          `${theme} --c-${name}-text saturation`
        ).toBeLessThan(0.03);
        const travel =
          theme === "light" ? fillLight - lightness : lightness - fillLight;
        expect(
          travel,
          `${theme} --c-${name}-text moved the wrong way`
        ).toBeGreaterThanOrEqual(0);
      }
    });

    test(`${theme}: the rung is legible against the fill it replaces`, () => {
      for (const [name, fillHex] of Object.entries(ring)) {
        const ink = evalColorMix(
          resolveVars(tokens[`--c-${name}-text`] ?? "", scope)
        );
        expect(
          oklabDistance(ink, fillHex),
          `${theme} --c-${name}-text collapsed onto its own fill`
        ).toBeLessThan(0.4);
      }
    });
  });
});
