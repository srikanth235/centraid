// The builder's syntax-highlighting scheme, read out of the stylesheet that
// declares it (#686).
//
// `.tokTag` / `.tokAttr` / `.tokStr` / `.tokKey` / `.tokCom` are 12px mono
// prose, so each owes the 4.5:1 body floor — the palette FILLS they used to
// carry measured 2.8–4.7:1 on light `--bg`. Rebinding them to the solved
// `--c-<hue>-text` rungs fixes that, but a highlighting scheme has a second
// contract the contrast grids cannot see: its members must stay TELLABLE
// APART, and solving several hues to one shared floor pulls them together.
//
// `.tokAttr` was violet and `.tokKey` indigo — 0.068 apart in oklab as fills,
// and the solve took them to 0.075 (light) / 0.040 (dark). This is the gate
// that caught it, and the one that stops the next hue swap from undoing the
// fix. Same law, same measurement, as the `docs` app's file-kind colours.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { toCss } from "@centraid/design";
import { contrastRatio } from "@centraid/design/color";
import {
  alphaOver,
  declarations,
  evalColorMix,
  oklabDistance,
  resolveVars,
} from "@centraid/design/oklab";

const AA_BODY = 4.5;
/** Oklab separation every pair in the scheme has to hold.
 *
 *  HIGHER than the 0.035 the `docs` file-kind labels are held to and the 0.06
 *  the three semantic states are: those appear one at a time, one per row or
 *  one per chip, where the eye compares a colour against its memory of the
 *  set. A code block shows all five simultaneously, interleaved word by word
 *  at 12px, where the eye compares them against each other — the harder task.
 *
 *  It is also calibrated to be RED for the defect it was written for: at 0.035
 *  the violet/indigo pair this replaced (0.075 light / 0.040 dark) sails
 *  through, and the gate would have been decoration. The shipped set's closest
 *  pair is 0.119 / 0.126, so this keeps ~1.5x headroom. */
const APART = 0.08;

const css = readFileSync(
  path.resolve(import.meta.dirname, "BuilderCode.module.css"),
  "utf8"
);

/** The `color:` a token class declares, as the token name it references. */
function inkTokenOf(className: string): string {
  const rule = new RegExp(
    String.raw`\.${className}\s*\{(?<body>[^}]*)\}`,
    "u"
  ).exec(css);
  expect(
    rule?.groups?.body,
    `.${className} exists in BuilderCode.module.css`
  ).toBeDefined();
  const ink = /color:\s*var\((?<name>--[\w-]+)\)/u.exec(
    rule?.groups?.body ?? ""
  );
  expect(
    ink?.groups?.name,
    `.${className} paints a tokened color`
  ).toBeDefined();
  return ink?.groups?.name ?? "";
}

/** Every class the tokenizer can emit into one `<pre>`, plus the untokenized
 *  remainder, which is `.diffText`/`--text` and has to be separable too. */
const TOKEN_CLASSES = ["tokTag", "tokAttr", "tokStr", "tokKey", "tokCom"];

/** The `background:` a rule declares, as the token name it references. */
function fillTokenOf(label: string, head: RegExp): string {
  const rule = head.exec(css);
  expect(
    rule?.groups?.body,
    `the ${label} dot rule exists in BuilderCode.module.css`
  ).toBeDefined();
  const fill = /background:\s*var\((?<name>--[\w-]+)\)/u.exec(
    rule?.groups?.body ?? ""
  );
  expect(
    fill?.groups?.name,
    `the ${label} dot paints a tokened fill`
  ).toBeDefined();
  return fill?.groups?.name ?? "";
}

/** The language-dot set — 6px fills shown together in the tab strip and the
 *  file tree, one per open file. Same law as the token inks above: until #686
 *  three of them named `--c-blue` / `--c-orange` / `--c-yellow`, hues the
 *  palette has never had, so those dots painted nothing at all and the gate
 *  that would have said so only walked blueprint apps.
 *
 *  `unknown` is the tree's fallback for a file kind with no dot of its own; it
 *  belongs in the separation set because a language dot that lands on it reads
 *  as "unrecognized file". */
const LANG_DOTS: readonly (readonly [string, RegExp])[] = [
  ["html", /\.tabDot\s*\{(?<body>[^}]*)\}/u],
  ["css", /\.tabDot\[data-lang="css"\]\s*\{(?<body>[^}]*)\}/u],
  ["js/ts", /\.tabDot\[data-lang="js"\][^{]*\{(?<body>[^}]*)\}/u],
  ["md", /\.tabDot\[data-lang="md"\]\s*\{(?<body>[^}]*)\}/u],
  ["unknown", /\.treeLangDot\s*\{(?<body>[^}]*)\}/u],
];

describe("the builder's syntax-token colours", () => {
  const stylesheet = toCss();
  const light = declarations(stylesheet, ":root");
  const dark = {
    ...light,
    ...declarations(stylesheet, "[data-theme='dark']"),
  };

  test("no token class paints a bare palette hue", () => {
    // `--c-<hue>` is an icon FILL. The repo-wide ratchet
    // (scripts/lint-design-tokens.mjs, `paletteHueAsText`) enforces this
    // across all client CSS; this restates it where the scheme is chosen.
    for (const className of TOKEN_CLASSES) {
      expect(
        inkTokenOf(className),
        `.${className} must take a solved rung, not a fill`
      ).not.toMatch(/^--c-(?!.*-text$)/u);
    }
  });

  describe.each([
    ["light", light, {}],
    ["dark", dark, { "--bg-l": "5%" }],
  ] as const)("%s", (theme, tokens, scope) => {
    // The `<pre>` sits on `--bg` (BuilderCode.module.css `.code`).
    const surface = evalColorMix(resolveVars(tokens["--bg"] ?? "", scope));

    /** `--text-ghost` ships as `rgba(… / 0.48)`. `contrastRatio` reads the RGB
     *  and ignores the alpha, which would score a 48% grey as full-strength
     *  ink — so composite it over the surface first, the way a browser does. */
    const flatten = (value: string): string => {
      const rgba =
        /^rgba?\(\s*(?<rgb>[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+)\s*,\s*(?<alpha>[\d.]+)\s*\)$/u.exec(
          value.trim()
        );
      return rgba?.groups
        ? alphaOver(
            `rgb(${rgba.groups.rgb})`,
            surface,
            Number(rgba.groups.alpha)
          )
        : value;
    };

    const inks = TOKEN_CLASSES.map((className) => ({
      className,
      hex: flatten(
        evalColorMix(resolveVars(tokens[inkTokenOf(className)] ?? "", scope))
      ),
    }));
    // Untokenized source text — a fifth colour in the same block.
    const plain = evalColorMix(resolveVars(tokens["--text"] ?? "", scope));

    test(`${theme}: every token colour clears the body floor on the code surface`, () => {
      for (const { className, hex } of inks) {
        expect(hex, `.${className} resolved`).not.toContain("var(");
        expect(
          contrastRatio(hex, surface),
          `${theme} .${className} on ${surface}`
        ).toBeGreaterThanOrEqual(
          // `.tokCom` is `--text-ghost` — a deliberately receded comment, held
          // to the 3:1 structural floor its own ramp is solved for
          // (packages/design/src/contrast.test.ts owns that rung).
          className === "tokCom" ? 3 : AA_BODY
        );
      }
    });

    test(`${theme}: the scheme stays mutually distinguishable`, () => {
      const all = [...inks, { className: "untokenized", hex: plain }];
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i];
          const b = all[j];
          // `.tokCom` IS `--text` at 38–48% alpha over the same surface, so it
          // and the untokenized remainder are the same hue by construction —
          // separated by lightness and italics, not by hue. Every OTHER pair
          // has to hold the floor.
          if (a?.className === "tokCom" && b?.className === "untokenized")
            continue;
          expect(
            oklabDistance(a?.hex ?? "", b?.hex ?? ""),
            `${theme} .${a?.className} vs .${b?.className} collapsed`
          ).toBeGreaterThan(APART);
        }
      }
    });

    const dots = LANG_DOTS.map(([label, head]) => ({
      label,
      // The dots sit on the tab strip / tree rather than the `<pre>`, but the
      // only translucent member is the `--text-ghost` unknown default, and
      // both surfaces are within a few percent of `--bg` — close enough that
      // compositing over `--bg` does not move the comparison.
      hex: flatten(
        evalColorMix(resolveVars(tokens[fillTokenOf(label, head)] ?? "", scope))
      ),
    }));

    test(`${theme}: the language dots stay mutually distinguishable`, () => {
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i];
          const b = dots[j];
          expect(a?.hex, `${a?.label} dot resolved`).not.toContain("var(");
          expect(
            oklabDistance(a?.hex ?? "", b?.hex ?? ""),
            `${theme} ${a?.label} vs ${b?.label} dot collapsed`
          ).toBeGreaterThan(APART);
        }
      }
    });

    test(`${theme}: no language dot collides with a syntax ink`, () => {
      // Both sets are on screen at once — the tab strip sits directly above
      // the tokenized `<pre>` — so a dot that matches a token colour reads as
      // meaning. `unknown` is exempt against `.tokCom`: both ARE
      // `--text-ghost`, one deliberately.
      for (const dot of dots) {
        for (const ink of inks) {
          if (dot.label === "unknown" && ink.className === "tokCom") continue;
          expect(
            oklabDistance(dot.hex, ink.hex),
            `${theme} ${dot.label} dot vs .${ink.className}`
          ).toBeGreaterThan(APART);
        }
      }
    });
  });
});
