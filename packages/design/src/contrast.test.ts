// governance: allow-repo-hygiene file-size-limit — this test is the single cross-emitter contrast matrix for shell, blueprint, kit, and native ink pairings; splitting its coupled floors would weaken the shared regression evidence.

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

const TEXT_FLOORS = {
  "--text": AA_BODY,
  "--text-soft": AA_BODY,
  "--text-faint": AA_BODY,
  "--text-ghost": AA_LARGE,
} as const;

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
      const fill = resolve(tokens["--accent-deep"] ?? "", scope);
      const ink = resolve(tokens["--text-inv"] ?? "", scope);
      expect(contrastRatio(ink, fill), `${name} fill`).toBeGreaterThanOrEqual(
        AA_BODY
      );
      const hover = evalColorMix(
        `color-mix(in oklab, ${fill} 88%, ${resolve(
          tokens["--text"] ?? "",
          scope
        )})`
      );
      expect(contrastRatio(ink, hover), `${name} hover`).toBeGreaterThanOrEqual(
        contrastRatio(ink, fill)
      );
      expect(tokens["--accent-fill"], `${name} --accent-fill`).toBeDefined();
    });

    test(`${name}: accent and status colours are legible as text`, () => {
      const bg = surfaces[0] ?? "";
      expect(
        contrastRatio(resolve(tokens["--accent-text"] ?? "", scope), bg),
        `${name} --accent-text`
      ).toBeGreaterThanOrEqual(AA_BODY);
      for (const token of SEMANTIC_STATES) {
        expect(tokens[token], `${name} ${token} is emitted`).toBeDefined();
      }
    });

    test(`${name}: semantic states clear the BODY floor on every surface`, () => {
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
        for (const surface of surfaces) {
          expect(
            contrastRatio(value, surface),
            `${name} ${token} on ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
          expect(
            contrastRatio(value, selfTint(value, surface)),
            `${name} ${token} on its own ${SELF_TINT * 100}% tint over ${surface}`
          ).toBeGreaterThanOrEqual(AA_BODY);
        }
      }
    });

    test(`${name}: semantic states still read as their role`, () => {
      for (const token of SEMANTIC_STATES) {
        const value = resolve(tokens[token] ?? "", scope);
        expect(
          Math.max(...surfaces.map((s) => contrastRatio(value, s))),
          `${name} ${token} still reads as its hue`
        ).toBeLessThan(RECOGNISABLE_STATE);
        expect(
          readsAsRole(value, token),
          `${name} ${token} (${value}) is no longer a ${token.slice(2)} colour`
        ).toBe(true);
      }
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

    test(`${name}: the v9 state and hover rungs clear their floors`, () => {
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

  const HUE = "0";
  const ROLES = ["--text", "--text-soft", "--text-faint"];

  describe.each([
    ["light", light, {}],
    ["dark", dark, {}],
  ] as const)("%s", (name, tokens, extra) => {
    const scope = { "--app-hue": HUE, ...extra };
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
      expect(contrastRatio(ink, hover), "hover").toBeGreaterThanOrEqual(
        contrastRatio(ink, fill)
      );
      expect(hover, "hover is a real step").not.toBe(fill);
      expect(contrastRatio(fill, card), "fill vs card").toBeGreaterThanOrEqual(
        AA_LARGE
      );
      expect(fill).toBe(evalColorMix(resolve(tokens["--text"] ?? "", {})));
    });
  });

  describe("every palette hue has a legible TEXT rung", () => {
    const TINT = 0.12;
    const RECOGNISABLE = 12;

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
        for (const [name, fillHex] of Object.entries(ring)) {
          const ink = evalColorMix(
            resolve(tokens[`--c-${name}-text`] ?? "", scope)
          );
          const [fillHue, fillSat, fillLight] = rgbToHsl(
            parseColor(fillHex).rgb
          );
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

      test(`${theme}: the file-kind hues stay apart as text`, () => {
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
    expect(light["--app-hue"]).toBe(HUE);
    expect(light["--app-identity"]).toBe("var(--text)");
    expect(light["--app-identity-text"]).toBe("var(--text)");
    expect(light["--bg-elev"]).not.toContain("var(--app-hue)");
    expect(light["--text"]).not.toContain("var(--app-hue)");
  });
});

describe("kit.css honours the ink contract for filled states", () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, "elements/kit.css"),
    "utf8"
  );

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
