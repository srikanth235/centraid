// WCAG floors for every ramp this package ships, measured against the actual
// EMITTED CSS rather than against literals copied out of it — a test that
// re-types the values it is guarding stops tracking them the moment someone
// edits the source.
//
// Floors (WCAG 2.1): 4.5:1 for body text (1.4.3), 3:1 for large text and
// non-text UI such as borders and icons (1.4.11). Each rung is measured on
// every surface it can land on, because a translucent rung that clears AA on
// `--bg` can still miss it on the sunken track.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { contrastRatio, parseColor, rgbToHsl, toHex } from "./color.js";
import { toCss } from "./css.js";
import { declarations, evalColorMix, oklabDistance } from "./oklab.js";
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

// ── Semantic states ────────────────────────────────────────────────────────
/** The three state roles, in the order the separation check reports them. */
const SEMANTIC_STATES = ["--danger", "--success", "--warning"] as const;
/** The self-wash strength `color.ts` solves these rungs for, and the strength
 *  every `color-mix(… var(--danger) N%, transparent)` chip in the tree uses. */
const SELF_TINT = 0.12;
/** Past this a state has stopped being its hue and become near-black (light)
 *  or near-white (dark). Same guard the accent fills carry. */
const RECOGNISABLE_STATE = 12;
/** …and the other way a solve can cheat: desaturate. A grey clears every
 *  contrast floor on every surface and stays 0.06 from its neighbours in
 *  oklab, and codes nothing — "this is an error" has to be legible as RED, not
 *  just legible. So each role is held to its hue family and to real chroma.
 *  Bands are wide (they are a sanity check, not a tuning knob) but they are
 *  closed: nothing outside them can be the role. */
const STATE_HUE = {
  // Red, wrapping 0.
  "--danger": [340, 20],
  // Green.
  "--success": [70, 160],
  // Amber/ochre.
  "--warning": [20, 60],
} as const;
const MIN_STATE_SATURATION = 0.2;

/** True while `value` still reads as `role`'s colour: right hue family, and
 *  saturated enough to be a hue at all rather than a grey. */
function readsAsRole(value: string, role: keyof typeof STATE_HUE): boolean {
  const [hue, sat] = rgbToHsl(parseColor(value).rgb);
  const [lo, hi] = STATE_HUE[role];
  const inBand = lo > hi ? hue >= lo || hue <= hi : hue >= lo && hue <= hi;
  return inBand && sat >= MIN_STATE_SATURATION;
}

/** `color-mix(in oklab, C 12%, transparent)` over `bg` — the alpha composite a
 *  browser performs for a state-tinted chip. */
function selfTint(value: string, bg: string): string {
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
      // The semantic states get their own grid below — this loop used to hold
      // them to AA_LARGE on `--bg` alone, which is what let `--danger` ship at
      // 3.74:1 on dark `--bg-elev`.
      for (const token of SEMANTIC_STATES) {
        expect(tokens[token], `${name} ${token} is emitted`).toBeDefined();
      }
    });

    test(`${name}: semantic states clear the BODY floor on every surface`, () => {
      // Not AA_LARGE. `--danger` / `--success` / `--warning` are documented as
      // states, but 131 `color:` rules across the client, the kit and the
      // blueprint apps paint them on 9–13.7px prose — under every large-text
      // exemption in 1.4.3. So the floor they owe is the body floor, on every
      // surface they can land on, not just `--bg`:
      //   `.kit-popover-item.danger` 13.6px on `--bg-elev` (and `--bg-sunken`
      //   on hover), `.kit-btn.danger` 13px on `--bg-elev`, `.tlError` 12px,
      //   `.lineLevel[data-level=error]` 9.5px…
      // The non-text uses (bar fills, hairlines, 1.05rem glyphs) are strictly
      // easier at 3:1, so pinning the body floor covers them too.
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
        for (const surface of surfaces) {
          expect(
            contrastRatio(value, surface),
            `${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
          // …and on a 12% wash of ITSELF over that surface, which is the
          // commonest site of all: `color: var(--danger)` on
          // `color-mix(in oklab, var(--danger) 12%, transparent)`. The wash
          // moves the background toward the ink, so it is strictly harder
          // than the bare surface and a rung can clear one and miss the other.
          expect(
            contrastRatio(value, selfTint(value, surface)),
            `${name} ${token} on its own ${SELF_TINT * 100}% tint over ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
        // The counterpart of the accent fills' cap: a state walked past this
        // has stopped being red/green/amber and become near-black or
        // near-white, which is the failure mode of "darken until it passes".
        expect(
          Math.max(...surfaces.map((s) => contrastRatio(value, s))),
          `${name} ${token} still reads as its hue`
        ).toBeLessThan(RECOGNISABLE_STATE);
        expect(
          readsAsRole(value, token),
          `${name} ${token} (${value}) is no longer a ${token.slice(2)} colour`
        ).toBe(true);
      }
      // A colour code is only a code while its members are tellable apart, and
      // solving three hues to one floor pulls them together.
      const inks = SEMANTIC_STATES.map((t) => resolve(tokens[t] ?? "", scope));
      for (let i = 0; i < inks.length; i++) {
        for (let j = i + 1; j < inks.length; j++) {
          expect(
            oklabDistance(inks[i] ?? "", inks[j] ?? ""),
            `${name} ${SEMANTIC_STATES[i]} vs ${SEMANTIC_STATES[j]} collapsed`
          ).toBeGreaterThan(0.06);
        }
      }
    });

    test(`${name}: the filled destructive button carries its ink`, () => {
      // `.kit-btn.primary.danger` — a `--danger` FILL under `--text-inv`, the
      // same contract `.kit-btn.primary` has. It inked with `--text` until
      // this gate existed, which is the SAME-side ink and measured 3.81:1 on
      // light / 4.09:1 on dark at the button's 13px.
      const fill = resolve(tokens["--danger"] ?? "", scope);
      const ink = resolve(tokens["--text-inv"] ?? "", scope);
      expect(
        contrastRatio(ink, fill),
        `${name} .kit-btn.primary.danger`
      ).toBeGreaterThanOrEqual(AA_BODY);
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

    test(`${name}: semantic states clear the BODY floor on card and track`, () => {
      // Same law as the shell grid above, re-measured off the OTHER emitter:
      // the app ramp has its own `--bg-l` (10%, not 5%) and its own state
      // literals, so a floor held on one emitter says nothing about the other.
      // Blueprint apps paint these on 10–13.7px prose — `tasks` `.flag.high`
      // 12px, `agenda` `.badge[data-tone=warn]` 10px on a `--warning` wash,
      // `docs` `.custodyChip` 12.8px, `tally`'s `--pos`/`--neg` aliases.
      // The floors are asserted on the shipped default hue for the same reason
      // the ink ramp above is; a retuned `--app-hue` moves these surfaces by
      // under 0.15 in ratio, inside the 0.3 margin the solve carries.
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
        expect(tokens[token], `blueprint ${name} ${token}`).toBeDefined();
        for (const surface of surfaces) {
          expect(
            contrastRatio(value, surface),
            `blueprint ${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
          expect(
            contrastRatio(value, selfTint(value, surface)),
            `blueprint ${name} ${token} on its own tint over ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
        expect(
          Math.max(...surfaces.map((s) => contrastRatio(value, s))),
          `blueprint ${name} ${token} still reads as its hue`
        ).toBeLessThan(RECOGNISABLE_STATE);
        expect(
          readsAsRole(value, token),
          `blueprint ${name} ${token} (${value}) is no longer a ${token.slice(2)} colour`
        ).toBe(true);
      }
      const inks = SEMANTIC_STATES.map((t) => resolve(tokens[t] ?? "", scope));
      for (let i = 0; i < inks.length; i++) {
        for (let j = i + 1; j < inks.length; j++) {
          expect(
            oklabDistance(inks[i] ?? "", inks[j] ?? ""),
            `blueprint ${name} ${SEMANTIC_STATES[i]} vs ${SEMANTIC_STATES[j]} collapsed`
          ).toBeGreaterThan(0.06);
        }
      }
    });

    test(`${name}: the filled destructive button carries its ink`, () => {
      // `.kit-btn.primary.danger` again — kit.css is shared, so the app ramp
      // has to satisfy the same pairing with ITS `--danger` and `--text-inv`.
      expect(
        contrastRatio(
          resolve(tokens["--text-inv"] ?? "", scope),
          resolve(tokens["--danger"] ?? "", scope)
        ),
        `blueprint ${name} .kit-btn.primary.danger`
      ).toBeGreaterThanOrEqual(AA_BODY);
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

  // ── The palette hues as TEXT ────────────────────────────────────────────
  //
  // `--c-*` are icon FILLS. Painted as `color:` on a near-white surface they
  // measure 2.2:1 (`--c-amber`) to 4.8:1 (`--c-indigo`) — which is why `docs`
  // hand-picked six deeper literals for its file-kind labels, and why #686
  // silently broke five of six by replacing those literals with the raw fills.
  // `--c-<name>-text` is the solved rung that closes the gap for every surface,
  // and this grid is what stops it drifting back.
  describe("every palette hue has a legible TEXT rung", () => {
    // A kind label sits on a weak tint of its OWN hue, so the surface has
    // already moved toward the ink. `docs` paints 12%; measuring the rung on a
    // plain card would miss exactly the case the app ships.
    const TINT = 0.12;
    // The counterpart of the fills' `RECOGNISABLE` cap: a rung that has been
    // walked past this has stopped being its hue and become near-black (light)
    // or near-white (dark), which defeats colour-coding six file kinds.
    const RECOGNISABLE = 12;

    /** `color-mix(in oklab, C p%, transparent)` over `bg` — the alpha
     *  composite a browser performs for `tintBg()`. */
    const tint = (hue: string, bg: string): string => {
      const fg = parseColor(hue).rgb;
      const back = parseColor(bg).rgb;
      return toHex(
        [0, 1, 2].map((i) => {
          const f = fg[i] ?? 0;
          const b = back[i] ?? 0;
          return f * TINT + b * (1 - TINT);
        }) as unknown as [number, number, number]
      );
    };

    describe.each([
      ["light", light, {}, ["--bg-elev", "--bg-sunken"]],
      ["dark", dark, { "--bg-l": "10%" }, ["--bg-elev", "--bg-sunken"]],
    ] as const)("%s", (theme, tokens, extra, surfaceNames) => {
      const scope = { "--app-hue": HUE, ...extra };
      const surfaces = surfaceNames
        .map((key) => evalColorMix(resolve(tokens[key] ?? "", scope)))
        .filter(measurable);

      test.each(Object.entries(palette))(
        `${theme}: --c-%s-text clears AA on every surface it lands on`,
        (name, fillHex) => {
          const value = tokens[`--c-${name}-text`];
          expect(value, `--c-${name}-text is emitted`).toBeDefined();
          const ink = evalColorMix(resolve(value ?? "", scope));
          expect(surfaces).toHaveLength(surfaceNames.length);
          for (const surface of surfaces) {
            expect(
              contrastRatio(ink, surface),
              `${theme} --c-${name}-text on ${surface}`
            ).toBeGreaterThanOrEqual(AA_BODY);
            // …and on a 12% tint of its own FILL over that surface, which is
            // the surface `docs` actually paints the label on.
            expect(
              contrastRatio(ink, tint(fillHex, surface)),
              `${theme} --c-${name}-text on its own ${TINT * 100}% tint`
            ).toBeGreaterThanOrEqual(AA_BODY);
          }
          expect(
            Math.max(...surfaces.map((s) => contrastRatio(ink, s))),
            `${theme} --c-${name}-text still reads as its hue`
          ).toBeLessThan(RECOGNISABLE);
        }
      );

      test(`${theme}: the rung is its fill's hue, moved only in lightness`, () => {
        // "Darken it until it passes" is only safe while hue and saturation
        // hold: the moment the solver is allowed to desaturate, eight hues
        // converge on one muddy grey that clears every floor and codes
        // nothing. The walk moves lightness ONLY, and in the direction the
        // theme requires — deeper under a light surface, lifted under a dark
        // one. (It cannot promise any two hues stay apart: `ochre` is `amber`
        // at lower chroma, and solving both to one floor converges them by
        // construction. That is a palette property, so the set that has to be
        // told apart is gated where it is chosen — see the `docs` app's
        // `kind-colours.test.ts` in packages/blueprints.)
        for (const [name, fillHex] of Object.entries(palette)) {
          const ink = evalColorMix(
            resolve(tokens[`--c-${name}-text`] ?? "", scope)
          );
          const [fillHue, fillSat, fillLight] = rgbToHsl(
            parseColor(fillHex).rgb
          );
          const [hue, sat, lightness] = rgbToHsl(parseColor(ink).rgb);
          // Tolerances are 8-bit re-quantisation slack, not licence to drift:
          // the walk re-rounds `hsl()` to a hex at every step.
          expect(
            Math.abs(hue - fillHue),
            `${theme} --c-${name}-text hue`
          ).toBeLessThan(2);
          expect(
            Math.abs(sat - fillSat),
            `${theme} --c-${name}-text saturation`
          ).toBeLessThan(0.03);
          // Signed travel, so one assertion covers both directions: the rung
          // must move AWAY from the theme's surface, never toward it.
          const travel =
            theme === "light" ? fillLight - lightness : lightness - fillLight;
          expect(
            travel,
            `${theme} --c-${name}-text moved the wrong way`
          ).toBeGreaterThanOrEqual(0);
        }
      });

      test(`${theme}: the file-kind hues stay apart as text`, () => {
        // A colour code is only a code while its members are TELLABLE APART,
        // and solving to a shared contrast floor pulls hues together — the
        // failure this guards is silent, because every rung still passes AA.
        // The set is the six the `docs` app colour-codes file kinds with
        // (`kind-colours.test.ts` in packages/blueprints pins that binding).
        // `ochre` is deliberately NOT in it: it is `amber` at lower chroma, so
        // the two converge from 0.125 apart as fills to 0.028 as light text.
        const KINDS = [
          "rose",
          "teal",
          "indigo",
          "forest",
          "amber",
          "violet",
        ] as const;
        const rungs = KINDS.map((name) => ({
          hex: evalColorMix(resolve(tokens[`--c-${name}-text`] ?? "", scope)),
          name,
        }));
        for (const a of rungs) {
          for (const b of rungs) {
            if (a.name >= b.name) continue;
            expect(
              oklabDistance(a.hex, b.hex),
              `${theme} ${a.name} vs ${b.name} collapsed`
            ).toBeGreaterThan(0.035);
          }
        }
      });
    });
  });

  test("the default app hue is the brand hue", () => {
    // 222 (ink-blue) was the pre-teal default; it tinted every unbranded app's
    // greys, ink and shadows toward a second, competing brand.
    expect(light["--app-hue"]).toBe(HUE);
  });
});

// ── The kit rules the grids above assume ───────────────────────────────────
//
// The token grids prove the PAIRINGS are legible; they cannot see which
// pairing a stylesheet actually writes. `.kit-btn.primary.danger` inked a
// `--danger` fill with `--text` — the same-side ink — and measured 3.81:1 on
// light / 4.09:1 on dark, so the value grid passed while the button did not.
describe("kit.css honours the ink contract for filled states", () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, "../kit/kit.css"),
    "utf8"
  );

  /** The declaration block that follows `selector`, sans nested rules. */
  function ruleBody(selector: string): string {
    const at = css.indexOf(selector);
    expect(at, `${selector} exists in kit.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", at);
    return css.slice(open + 1, css.indexOf("}", open));
  }

  test("the filled destructive button carries --text-inv, not --text", () => {
    const body = ruleBody(".kit-btn.primary.danger,");
    expect(body).toContain("background: var(--danger)");
    expect(body).toContain("color: var(--text-inv)");
    // `--text` is the SAME-side ink in both themes; on a mid-lightness red it
    // is a WCAG 1.4.3 failure on BOTH ramps, which is the exact bug this pins.
    expect(body).not.toMatch(/color:\s*var\(--text\)/u);
  });
});
