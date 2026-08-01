/**
 * Generated-stylesheet value laws (#656 Layer 3 mutation seed).
 *
 * `css.test.ts` calls `toCss()` once at MODULE scope. Under Stryker's
 * `ignoreStatic` that makes every mutant in `css.ts` and `typography.ts` a
 * static mutant — i.e. the generator had a test suite and still contributed
 * zero mutants to measure. These call the generator inside each test so the
 * assertions actually defend it, and they check the emitted VALUES (the px
 * suffix, the kebab-case mapping, the var-before-use ordering) rather than
 * only which property names appear.
 */
import { describe, expect, test } from "vitest";

import { toCss } from "./css.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { themes } from "./themes/index.js";
import {
  fontStacks,
  marketingType,
  type,
  typeShorthand,
} from "./typography.js";

/** Parse the sheet into `selector -> {prop: value}` without assuming order. */
function parseBlocks(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  const re = /(?<selector>[^{}\n]+)\s*\{(?<body>[^}]*)\}/gu;
  for (const match of css.matchAll(re)) {
    const selector = (match.groups?.selector ?? "").trim();
    const props = new Map<string, string>();
    for (const line of (match.groups?.body ?? "").split("\n")) {
      const decl = /^\s*(?<prop>--[\w-]+):\s*(?<value>.*);\s*$/u.exec(line);
      if (decl?.groups) {
        props.set(decl.groups.prop as string, decl.groups.value as string);
      }
    }
    blocks.set(selector, props);
  }
  return blocks;
}

describe("token stylesheet values", () => {
  test("every declaration is a custom property with a non-empty value", () => {
    const blocks = parseBlocks(toCss());
    expect(blocks.size).toBeGreaterThan(0);
    for (const [selector, props] of blocks) {
      expect(props.size, selector).toBeGreaterThan(0);
      for (const [prop, value] of props) {
        expect(prop.startsWith("--"), `${selector} ${prop}`).toBe(true);
        expect(value.trim(), `${selector} ${prop}`).not.toBe("");
      }
    }
  });

  test("palette hues carry their canonical values", () => {
    const root = parseBlocks(toCss()).get(":root");
    for (const [key, value] of Object.entries(palette)) {
      expect(root?.get(`--c-${key}`), key).toBe(value);
    }
  });

  test("radii are emitted in px, not as bare numbers", () => {
    const blocks = parseBlocks(toCss());
    const root = blocks.get(":root");
    for (const [key, value] of Object.entries(radii)) {
      expect(root?.get(`--r-${key}`), key).toBe(`${value}px`);
    }
  });

  test("camelCase type keys map to kebab-case properties, one per style", () => {
    const root = parseBlocks(toCss()).get(":root");
    const emitted = [...(root?.keys() ?? [])].filter((k) =>
      k.startsWith("--t-")
    );
    const scale = { ...type, ...marketingType };
    expect(emitted).toHaveLength(Object.keys(scale).length);
    for (const [key, style] of Object.entries(scale)) {
      const kebab = key
        .replace(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
        .toLowerCase();
      // The VALUE must be the shorthand for that exact style — not merely a
      // property with the right name.
      expect(root?.get(`--t-${kebab}`), key).toBe(typeShorthand(style));
    }
    // No property may keep a capital letter; CSS custom properties are
    // case-sensitive, so `--t-bodyStrong` would silently never match.
    expect(emitted.every((k) => k === k.toLowerCase())).toBe(true);
  });

  test("each font stack is emitted once under its family name", () => {
    const root = parseBlocks(toCss()).get(":root");
    for (const [key, value] of Object.entries(fontStacks)) {
      expect(root?.get(`--font-${key}`), key).toBe(value);
    }
  });

  test("every theme block defines the same property set as every other", () => {
    const blocks = parseBlocks(toCss());
    const names = Object.keys(themes);
    expect(names.length).toBeGreaterThan(1);
    const sets = names.map((name) => {
      const block = blocks.get(`[data-theme='${name}']`);
      expect(block, name).toBeDefined();
      return [...(block?.keys() ?? [])].sort();
    });
    // A theme missing a token inherits the previous theme's value — the exact
    // failure mode #608 group P describes. Only `--bg-l` is dark-only.
    const optional = new Set(["--bg-l"]);
    const required = sets.map((s) => s.filter((k) => !optional.has(k)));
    for (const set of required) expect(set).toStrictEqual(required[0]);
  });

  test("`:root` carries the light theme, so an unset data-theme is light", () => {
    const blocks = parseBlocks(toCss());
    const root = blocks.get(":root");
    const light = blocks.get("[data-theme='light']");
    for (const [prop, value] of light ?? []) {
      expect(root?.get(prop), prop).toBe(value);
    }
  });

  test("a theme block defines --bg-l before every surface that derives from it", () => {
    // `themeProps` inserts `--bg-l` out of alphabetical order on purpose so
    // the dark ramp's anchor is declared ahead of its consumers. The whole
    // point of the anchor is that retuning one number retunes the ramp; a
    // mutant that moves the insert (or drops the `!== undefined` guard) is
    // invisible to a test that only checks which names appear.
    for (const [selector, props] of parseBlocks(toCss())) {
      if (!selector.startsWith("[data-theme=")) continue;
      const order = [...props.keys()];
      const anchorAt = order.indexOf("--bg-l");
      const consumers = order.filter(
        (prop) => prop !== "--bg-l" && props.get(prop)?.includes("var(--bg-l)")
      );
      if (consumers.length === 0) continue;
      expect(
        anchorAt,
        `${selector} consumes --bg-l without defining it`
      ).toBeGreaterThanOrEqual(0);
      for (const consumer of consumers) {
        expect(
          order.indexOf(consumer),
          `${selector} ${consumer}`
        ).toBeGreaterThan(anchorAt);
      }
    }
  });

  test("only the ramp that declares an anchor consumes one", () => {
    const blocks = parseBlocks(toCss());
    for (const name of Object.keys(themes)) {
      const props = blocks.get(`[data-theme='${name}']`);
      const declares = props?.has("--bg-l") ?? false;
      const consumes = [...(props?.values() ?? [])].some((v) =>
        v.includes("var(--bg-l)")
      );
      expect(consumes && !declares, name).toBe(false);
      expect(declares, name).toBe(
        themes[name as keyof typeof themes].bgL !== undefined
      );
    }
  });

  test("the sheet is a single balanced, banner-led document", () => {
    const css = toCss();
    expect(css.startsWith("/* Generated by @centraid/design")).toBe(true);
    expect(css.endsWith("\n")).toBe(true);
    expect(css.split("{")).toHaveLength(css.split("}").length);
    // One block per theme plus the default :root.
    expect(parseBlocks(css).size).toBe(1 + Object.keys(themes).length);
  });

  test("generation is deterministic — same input, same bytes", () => {
    expect(toCss()).toBe(toCss());
  });
});

describe("type shorthand", () => {
  test("every style renders as a valid CSS font shorthand", () => {
    for (const [key, style] of Object.entries({ ...type, ...marketingType })) {
      const shorthand = typeShorthand(style);
      const m =
        /^(?<weight>\d{3}) (?<size>\d+)px\/(?<lh>[\d.]+(?:px)?) var\(--font-(?<family>[a-z]+)\)$/u.exec(
          shorthand
        );
      expect(m, `${key}: ${shorthand}`).not.toBeNull();
      const g = m?.groups as Record<string, string>;
      expect(g.weight).toBe(style.weight);
      expect(Number(g.size)).toBe(style.size);
      // The family must name a stack this package actually emits.
      expect(Object.keys(fontStacks)).toContain(g.family);
      expect(g.family).toBe(style.family);
    }
  });

  test("a px line-height gets a unit and a unitless multiplier does not", () => {
    // Mixing these up is a 22x line-height (unreadable) or a 1.1px one
    // (overlapping text) — the two type scales must not converge.
    for (const style of Object.values(type)) {
      expect(typeShorthand(style)).toContain(`/${style.lineHeight}px `);
    }
    for (const style of Object.values(marketingType)) {
      expect(typeShorthand(style)).toContain(`/${style.lineHeight} `);
      expect(typeShorthand(style)).not.toContain(`/${style.lineHeight}px`);
    }
  });

  test("size and line-height are carried through, not recomputed", () => {
    expect(
      typeShorthand({
        family: "mono",
        lineHeight: 99,
        size: 42,
        weight: "500",
      })
    ).toBe("500 42px/99px var(--font-mono)");
    expect(
      typeShorthand({
        family: "display",
        lineHeight: "1.75",
        size: 40,
        weight: "700",
      })
    ).toBe("700 40px/1.75 var(--font-display)");
  });
});
