// The palette hues as TEXT, measured on the SHELL's surfaces (#686).
//
// `contrast.test.ts` already pins `--c-<name>-text` — but only off
// `toBlueprintCss()`, whose dark ramp is anchored at `--bg-l: 10%` and whose
// only measurable surfaces are the card and the recessed track. The shell is a
// different emitter with a different ramp (`--bg-l: 5%`) and two more surfaces
// (`--bg`, `--bg-app`), and packages/client paints these rungs on all four.
//
// A floor held on one emitter says nothing about the other, which is exactly
// how the raw fills survived in ~30 client `color:` sites: as ink on the
// shell's own surfaces they measure 2.04–5.03:1 on light and 3.12–8.44:1 on
// dark — 17 of 32 cells below AA, every hue failing on at least one theme, and
// amber missing even the 3:1 non-text floor that an icon glyph owes.

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
import { palette } from "./palette.js";

const AA_BODY = 4.5;

/** Every opaque surface the shell can paint a foreground on. */
const SURFACE_NAMES = ["--bg", "--bg-app", "--bg-elev", "--bg-sunken"] as const;

/** A palette ink is almost never on a bare surface — it sits on a weak wash of
 *  its own FILL (a chip, a badge, an identity tile), which has already walked
 *  the background toward the ink. These are the strengths packages/client
 *  actually paints under a rebound `--c-*-text`; 16% is the ceiling, and the
 *  one 18% site (`ApprovalsScreen.noticeTile`) was brought back to 12% because
 *  indigo and violet fell to 4.44 / 4.49 there. Raising any of these past 16%
 *  spends contrast the solve did not buy — that is what this list pins. */
const WASHES = [0.06, 0.07, 0.08, 0.1, 0.12, 0.14, 0.16] as const;

/** Past this a rung has stopped being its hue and become near-black (light) or
 *  near-white (dark) — the failure mode of "darken until it passes". */
const RECOGNISABLE = 12;

describe("palette-hue-as-text on the shell surfaces", () => {
  const css = toCss();
  const light = declarations(css, ":root");
  const dark = { ...light, ...declarations(css, "[data-theme='dark']") };

  describe.each([
    ["light", light, {}],
    // The shell's dark ramp is anchored at 5%, NOT the blueprint layer's 10%.
    // Substituted because only a browser resolves `hsl(0 0% var(--bg-l))`.
    ["dark", dark, { "--bg-l": "5%" }],
  ] as const)("%s", (theme, tokens, scope) => {
    const surfaces = SURFACE_NAMES.map((key) =>
      evalColorMix(resolveVars(tokens[key] ?? "", scope))
    );

    test(`${theme}: every shell surface resolves to a measurable colour`, () => {
      // An unresolved `var()` would silently make every ratio below a
      // no-op — this is the guard that the substitution actually landed.
      expect(surfaces).toHaveLength(SURFACE_NAMES.length);
      for (const surface of surfaces) {
        expect(surface, `${theme} surface`).toMatch(/^(?:#|rgba?\(|hsla?\()/u);
        expect(surface, `${theme} surface`).not.toContain("var(");
      }
    });

    test.each(Object.entries(palette))(
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
      // Re-measured off THIS emitter for the same reason the floors are: the
      // moment a solve is allowed to desaturate, eight hues converge on one
      // grey that clears every floor and codes nothing.
      for (const [name, fillHex] of Object.entries(palette)) {
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
      // The pairing that reads worst in practice: an ink label beside its own
      // saturated dot or bar. Not an AA site (the dot is non-text), but if the
      // two collapse, the label stops looking like the same state as the dot.
      for (const [name, fillHex] of Object.entries(palette)) {
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
