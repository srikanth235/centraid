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
import { contrastRatio } from "./color.js";
import { toCss } from "./css.js";

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

  test("the default app hue is the brand hue", () => {
    // 222 (ink-blue) was the pre-teal default; it tinted every unbranded app's
    // greys, ink and shadows toward a second, competing brand.
    expect(light["--app-hue"]).toBe(HUE);
  });
});
