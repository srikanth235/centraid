// governance: allow-repo-hygiene file-size-limit — this test is the single cross-emitter contrast matrix for shell, blueprint, kit, and native ink pairings; splitting its coupled floors would weaken the shared regression evidence.
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
import { toNativeTheme } from "./native.js";
import {
  alphaOver,
  declarations,
  evalColorMix,
  oklabDistance,
  readsAsRole,
  RECOGNISABLE_STATE,
  SELF_TINT,
  SEMANTIC_STATES,
  selfTint,
} from "./oklab.js";
import { palette, paletteDark } from "./palette.js";

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
 *  one `calc()` form in use. Native does not need this parser: its direct
 *  lowering already contains concrete values. */
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

  // Every opaque surface a foreground can be painted on. There is no per-app
  // surface tone axis — one page, for the shell and every app in it — so
  // this is the shell's fixed surface set. The dark ramp used to be a
  // `--bg-l` calc that only a browser could resolve; both ramps are literal
  // now, so nothing needs substituting.
  const SURFACE_NAMES = ["--bg", "--bg-app", "--bg-elev", "--bg-sunken"];

  describe.each([
    ["light", light, {}],
    ["dark", dark, {}],
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
      // Fills publish their own ink; there is no renderer-side foreground
      // choice or legacy --text-inv alias.
      expect(tokens["--accent-fill"], `${name} --accent-fill`).toBeDefined();
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
      }
    });

    // Split from the floor test above: a recognisability failure reported under
    // the heading "clears the BODY floor" names the wrong cause, and a test that
    // misnames its own failure is the thing this whole change set is about.
    test(`${name}: semantic states still read as their role`, () => {
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
        // The counterpart of the accent fills' cap: a state walked past this
        // has stopped being red/green/amber and become near-black or
        // near-white, which is the failure mode of "darken until it passes".
        expect(
          Math.max(...surfaces.map((s) => contrastRatio(value, s))),
          `${name} ${token} still reads as its hue`
        ).toBeLessThan(RECOGNISABLE_STATE);
        // A grey clears every contrast floor and codes nothing; hue band plus
        // minimum chroma is what stops "legible" from passing for "meaningful".
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

    // The filled destructive button (`.kit-btn.primary.danger`, née the
    // `destructiveFilled` variant) is retired with the Binding Layer flip —
    // destructive is OUTLINED in `--net`/`--danger`, never a fill, so there
    // is no danger-under-`--text-inv` fill pairing left to pin here. See
    // "keeps the ink contract for filled states" below for the StatusLine
    // fill/track pairing that replaces this coverage.

    test(`${name}: the v9 state and hover rungs clear their floors`, () => {
      // `--seam`, `--net-hover` and `--accent-hover` are all BORDER-AND-LABEL
      // rungs: destructive is outlined and never filled, and a seam state is a
      // chip with a rule around it, so each one is simultaneously the type and
      // the edge. That means one floor covers both jobs — AA as text, which is
      // strictly harder than the 3:1 a border owes.
      for (const token of ["--seam", "--net-hover", "--accent-hover"]) {
        const value = resolve(tokens[token] ?? "", scope);
        expect(value, `${name} ${token} is emitted`).toBeTruthy();
        for (const surface of surfaces) {
          expect(
            contrastRatio(value, surface),
            `${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    });

    test(`${name}: --net stays legible ON its own wash`, () => {
      // The whole permission `--net-wash` is granted under: a tint faint
      // enough that the ink it belongs to, and the ramp beside it, still read
      // on top. If this fails the wash has stopped being a wash and become the
      // large alarming filled surface `--net` forbids.
      const washed = resolve(tokens["--net-wash"] ?? "", scope);
      expect(washed, `${name} --net-wash is emitted`).toMatch(/^rgba\(/u);
      for (const surface of surfaces) {
        const ground = alphaOver(washed, surface, parseColor(washed).alpha);
        for (const token of ["--net", "--text", "--text-soft"]) {
          expect(
            contrastRatio(resolve(tokens[token] ?? "", scope), ground),
            `${name} ${token} on --net-wash over ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    });

    test(`${name}: the hover rungs step the way their job requires`, () => {
      // `--net` is not at the end of its ramp, so its hover moves AWAY from
      // the paper — a warning that quietens under the pointer is wrong. The
      // accent IS the end of its ramp, so an outline's ink can only step
      // toward the paper; nothing rides on top of it, so that costs nothing
      // the floor above has not already measured.
      const page = surfaces[0] ?? "";
      const net = resolve(tokens["--net"] ?? "", scope);
      const netHover = resolve(tokens["--net-hover"] ?? "", scope);
      expect(
        contrastRatio(netHover, page),
        `${name} --net-hover`
      ).toBeGreaterThan(contrastRatio(net, page));
      const accent = resolve(tokens["--accent"] ?? "", scope);
      const accentHover = resolve(tokens["--accent-hover"] ?? "", scope);
      expect(accentHover, `${name} --accent-hover is a real step`).not.toBe(
        accent
      );
      expect(
        contrastRatio(accentHover, page),
        `${name} --accent-hover`
      ).toBeLessThan(contrastRatio(accent, page));
    });

    test(`${name}: the status line's determinate fill carries its ink`, () => {
      // `.kit-status-line-fill` paints `--text` — the SAME ink `--text-soft`
      // (the line's own foreground) is already validated against — on
      // `--bg-elev` (`.kit-status-line-track`), never a hue: a long local
      // operation is reported in the ink ramp, not a tone.
      const fill = resolve(tokens["--text"] ?? "", scope);
      const track = resolve(tokens["--bg-elev"] ?? "", scope);
      expect(
        contrastRatio(fill, track),
        `${name} .kit-status-line-fill on .kit-status-line-track`
      ).toBeGreaterThanOrEqual(AA_LARGE);
    });
  });
});

describe("blueprint token contrast floors", () => {
  const css = toBlueprintCss();
  const light = declarations(css, ":root");
  const dark = { ...light, ...declarations(css, ":root[data-theme='dark']") };

  // `--app-hue` is the app's slot on the identity wheel; hue 0 is the wheel
  // origin an app inherits when it declares none. Nothing in the surface ramp
  // reads it any more, which is why the floors below need no hue scope.
  const HUE = "0";
  // The app layer has no `--text-ghost`; its ramp stops at faint.
  const ROLES = ["--text", "--text-soft", "--text-faint"];

  describe.each([
    ["light", light, {}],
    ["dark", dark, {}],
  ] as const)("%s", (name, tokens, extra) => {
    const scope = { "--app-hue": HUE, ...extra };
    // The blueprint layer owns the page, the card and the recessed track; the
    // card and the track are the two the ink ramp is hardest against.
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
      // Same law as the shell grid above, re-measured off the OTHER emitter.
      // The two emitters now share one surface ramp, which is exactly why this
      // must keep being measured separately: the moment one of them re-tunes a
      // surface, a floor held on the other says nothing. Blueprint apps paint
      // these on 11–13.7px prose — `tasks` `.flag.high` 12px, `agenda`
      // `.badge[data-tone=warn]` on a `--warning` wash, `docs` `.custodyChip`.
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
      }
    });

    // Split for the same reason as the shell pair above: legibility and
    // recognisability are different properties and must fail under different
    // headings.
    test(`${name}: app-surface semantic states still read as their role`, () => {
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
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

    // The filled destructive button is retired (see the shell grid above) —
    // kit.css is shared, so nothing app-surface-specific to pin here either.

    test(`${name}: the status line's determinate fill carries its ink on the app surface`, () => {
      const fill = resolve(tokens["--text"] ?? "", scope);
      const track = resolve(tokens["--bg-elev"] ?? "", scope);
      expect(
        contrastRatio(fill, track),
        `blueprint ${name} .kit-status-line-fill on .kit-status-line-track`
      ).toBeGreaterThanOrEqual(AA_LARGE);
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

  // ── The one filled action, which is INK ────────────────────────────────
  //
  // This grid used to walk eight accent hues, because an app could retune the
  // product accent and one fixed ink could not serve all of them. The Binding
  // Layer removed the choice at the root: the accent IS the ink, so what has
  // to be proved is different and much sharper — the fill carries its ink, the
  // HOVER never walks back toward that ink, and the fill is still findable
  // against the card behind it.
  describe("the filled ink action carries its ink", () => {
    test.each([
      ["light", light],
      ["dark", dark],
    ] as const)("%s", (_theme, tokens) => {
      const fill = evalColorMix(resolve(tokens["--accent-fill"] ?? "", {}));
      const ink = evalColorMix(resolve(tokens["--text-inv"] ?? "", {}));
      const hover = evalColorMix(
        resolve(tokens["--accent-deep-hover"] ?? "", {})
      );
      const card = evalColorMix(resolve(tokens["--bg-elev"] ?? "", {}));

      expect(contrastRatio(ink, fill), "rest").toBeGreaterThanOrEqual(AA_BODY);
      // Hover moves AWAY from the ink, never toward it. A hover that reduces
      // the label's contrast is the failure this pins, and with an ink fill it
      // is the only remaining way to get it wrong.
      expect(contrastRatio(ink, hover), "hover").toBeGreaterThanOrEqual(
        contrastRatio(ink, fill)
      );
      expect(hover, "hover is a real step").not.toBe(fill);
      expect(contrastRatio(fill, card), "fill vs card").toBeGreaterThanOrEqual(
        AA_LARGE
      );
      // …and the fill is ink, not a hue. If a hue ever creeps back in here,
      // every app identity colour silently stops meaning anything.
      expect(fill).toBe(evalColorMix(resolve(tokens["--text"] ?? "", {})));
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
      ["light", light, palette, ["--bg-elev", "--bg-sunken"]],
      ["dark", dark, paletteDark, ["--bg-elev", "--bg-sunken"]],
    ] as const)("%s", (theme, tokens, ring, surfaceNames) => {
      const scope = { "--app-hue": HUE };
      const surfaces = surfaceNames
        .map((key) => evalColorMix(resolve(tokens[key] ?? "", scope)))
        .filter(measurable);

      test.each(Object.entries(ring))(
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
        for (const [name, fillHex] of Object.entries(ring)) {
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

  test("an app that declares no identity inherits no hue", () => {
    // `--app-hue` used to tint every unbranded app's greys, ink and shadows
    // toward whatever identity it had declared, which is how the neutrals
    // stopped being shared. It parameterises nothing now: the blueprint
    // surface paints the system's literal paper, and the hue is only the
    // app's slot on the identity wheel.
    expect(light["--app-hue"]).toBe(HUE);
    expect(light["--app-identity"]).toBe("var(--text)");
    expect(light["--app-identity-text"]).toBe("var(--text)");
    expect(light["--bg-elev"]).not.toContain("var(--app-hue)");
    expect(light["--text"]).not.toContain("var(--app-hue)");
  });
});

// ── The kit rules the grids above assume ───────────────────────────────────
//
// The token grids prove the PAIRINGS are legible; they cannot see which
// pairing a stylesheet actually writes. `.kit-btn.primary.danger` used to ink
// a `--danger` fill with `--text` — the same-side ink — and measured 3.81:1 on
// light / 4.09:1 on dark, so the value grid passed while the button did not.
// The filled destructive button is retired outright with the Binding Layer
// flip (destructive is OUTLINED in `--net`/`--danger`, never a fill), so this
// describe now pins that retirement plus the StatusLine determinate fill that
// replaces it as the model of "report state in the ink ramp, not a hue".
describe("kit.css honours the ink contract for filled states", () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, "elements/kit.css"),
    "utf8"
  );

  /** The declaration block that follows `selector`, sans nested rules. */
  function ruleBody(selector: string): string {
    const at = css.indexOf(selector);
    expect(at, `${selector} exists in kit.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", at);
    return css.slice(open + 1, css.indexOf("}", open));
  }

  test("retires the filled destructive button — no danger fill remains", () => {
    expect(css).not.toContain(".kit-btn.primary.danger");
    expect(css).not.toContain("destructiveFilled");
  });

  test("the status line's determinate fill is ink, never a hue", () => {
    const body = ruleBody(".kit-status-line-fill {");
    expect(body).toContain("background: var(--text)");
    expect(body).not.toMatch(/background:\s*var\(--danger\)/u);
    expect(body).not.toMatch(/background:\s*var\(--accent/u);
  });
});

describe("native token contrast floors", () => {
  test.each(["light", "dark"] as const)(
    "%s lowers concrete semantic pairings",
    (scheme) => {
      const { colors } = toNativeTheme(scheme);
      const surfaces = [colors.bg, colors.bgElev, colors.bgSunken];

      for (const [name, floor] of [
        ["text", AA_BODY],
        ["textSoft", AA_BODY],
        ["textFaint", AA_BODY],
      ] as const) {
        for (const surface of surfaces) {
          expect(
            contrastRatio(colors[name], surface),
            `${scheme} ${name} on ${surface}`
          ).toBeGreaterThanOrEqual(floor);
        }
      }

      expect(
        contrastRatio(colors.textInv, colors.accentDeep)
      ).toBeGreaterThanOrEqual(AA_BODY);
      expect(
        contrastRatio(colors.accentText, colors.bg)
      ).toBeGreaterThanOrEqual(AA_BODY);
      for (const value of Object.values(colors)) {
        expect(value).not.toMatch(/(?:var\(|calc\(|color-mix\()/u);
      }
    }
  );
});
