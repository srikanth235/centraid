import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract.js";
import { toCss } from "./css.js";
import { spacing } from "./density.js";
import { library } from "./library.js";
import { palette, paletteText } from "./palette.js";
import { radii } from "./radii.js";
import { BRAND, themes } from "./themes/index.js";
import {
  blueprintType,
  blueprintTypeShorthand,
  NATIVE_DELTA_BY_FAMILY,
  NATIVE_DELTA_OVERRIDES,
  nativeTypeStyle,
  remSizeScale,
  toRemStyle,
  type,
  typeModifiers,
  typeSizeRungs,
} from "./typography.js";

function parseBlocks(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  const re = /(?<selector>[^{}\n]+)\s*\{(?<body>[^}]*)\}/gu;
  for (const match of css.matchAll(re)) {
    const selector = (match.groups?.selector ?? "").trim();
    const props = new Map<string, string>();
    for (const line of (match.groups?.body ?? "").split("\n")) {
      const declaration = /^\s*(?<prop>--[\w-]+):\s*(?<value>.*);\s*$/u.exec(
        line
      );
      if (declaration?.groups) {
        props.set(
          declaration.groups.prop as string,
          declaration.groups.value as string
        );
      }
    }
    blocks.set(selector, props);
  }
  return blocks;
}

describe("generated stylesheet values", () => {
  test("shell and blueprint roots publish their exact contracts", () => {
    const shell = parseBlocks(toCss()).get(":root");
    const blueprint = parseBlocks(toBlueprintCss()).get(":root");
    expect([...(shell?.keys() ?? [])].sort()).toStrictEqual(
      SHELL_TOKEN_CONTRACT
    );
    expect([...(blueprint?.keys() ?? [])].sort()).toStrictEqual(
      BLUEPRINT_TOKEN_CONTRACT
    );
  });

  test("shared palette, radius, spacing and tile values are emitted once", () => {
    const root = parseBlocks(toCss()).get(":root");
    for (const [key, value] of Object.entries(palette))
      expect(root?.get(`--c-${key}`)).toBe(value);
    for (const [key, value] of Object.entries(paletteText.light))
      expect(root?.get(`--c-${key}-text`)).toBe(value);
    for (const [key, value] of Object.entries(radii))
      expect(root?.get(`--r-${key}`)).toBe(`${value}px`);
    for (const [key, value] of Object.entries(spacing))
      expect(root?.get(`--sp-${key}`)).toBe(`${value}px`);
    for (const [key, value] of Object.entries(library)) {
      const suffix = key.startsWith("tile-") ? key.slice("tile-".length) : key;
      expect(root?.get(`--tile-${suffix}`)).toBe(value);
    }
  });

  test("the type scale is one role set and size rungs collapse duplicates", () => {
    const root = parseBlocks(toCss()).get(":root");
    for (const [key, value] of Object.entries(type)) {
      const { size, lineHeight } = toRemStyle(value);
      expect(
        root?.get(
          `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`
        )
      ).toContain(`${size}/${lineHeight}`);
    }
    // SIX distinct sizes, ten roles. `--t-body-strong-size` would duplicate the
    // body rung and `--t-small-strong-size` the UI rung; `--t-eyebrow-size` and
    // `--t-mono-size` would both duplicate the micro rung, because v7 folded
    // the numeric role from 11.5 to 11 — annotation, micro caps and numerics
    // are one 11px rung with one name. The declaration order in `typography.ts`
    // is what decides which name owns each rung, which is why it is ramp order
    // and not alphabetical.
    const rungs = typeSizeRungs(remSizeScale(type));
    expect(Object.keys(rungs)).toStrictEqual([
      "--t-display-size",
      "--t-title-size",
      "--t-reading-size",
      "--t-body-size",
      "--t-small-size",
      "--t-control-size",
    ]);
    // rem = px / 16 — the shell now emits host-relative units (issue #708)
    // so 200% OS text scale, which moves the ROOT font-size, actually reaches
    // these rungs; a `px` literal would be invisible to that preference.
    // 0.71875rem is gone with the 11.5px size it lowered: a rung whose rem
    // value needs five decimal places is the tell v7 named.
    expect(Object.values(rungs)).toStrictEqual([
      "1.9375rem",
      "1.25rem",
      "1.1875rem",
      "0.9375rem",
      "0.8125rem",
      "0.6875rem",
    ]);
    // Nothing in the ramp falls below 11px.
    for (const value of Object.values(type)) {
      expect(value.size, "11px floor").toBeGreaterThanOrEqual(11);
    }
    // The `font` shorthand has no slot for tracking, caps or figure spacing,
    // so those travel beside it as their own tokens rather than as decoration
    // a stylesheet remembers to add. "Numerics are tabular in every app,
    // without exception" is only true while `--t-mono-numeric` exists.
    expect(typeModifiers(type)).toStrictEqual({
      "--t-display-tracking": "-0.01em",
      "--t-eyebrow-tracking": "0.06em",
      "--t-eyebrow-transform": "uppercase",
      "--t-mono-numeric": "tabular-nums",
      "--t-mono-direction": "ltr",
      "--t-mono-bidi": "isolate",
    });
    for (const [name, value] of Object.entries(typeModifiers(type))) {
      expect(root?.get(name), name).toBe(value);
      expect(
        parseBlocks(toBlueprintCss()).get(":root")?.get(name),
        `${name} blueprint`
      ).toBe(value);
    }
  });

  test("native deltas come from the family contract, or from a named override", () => {
    for (const [key, value] of Object.entries(type)) {
      const override = (
        NATIVE_DELTA_OVERRIDES as Record<string, typeof value.nativeDelta>
      )[key];
      expect(value.nativeDelta, key).toStrictEqual(
        override ?? NATIVE_DELTA_BY_FAMILY[value.family]
      );
      expect(nativeTypeStyle(value)).toStrictEqual({
        ...value,
        lineHeight: value.lineHeight + value.nativeDelta.lineHeight,
        size: value.size + value.nativeDelta.size,
      });
    }
    // The overrides are exactly the two roles the brief gives a smaller mobile
    // size for; every other role gains a point or two on a phone.
    expect(Object.keys(NATIVE_DELTA_OVERRIDES)).toStrictEqual([
      "display",
      "reading",
    ]);
    expect(type.display.size + type.display.nativeDelta.size).toBe(27);
    expect(type.reading.size + type.reading.nativeDelta.size).toBe(17.5);
  });

  test("every theme publishes exactly the same role set", () => {
    const blocks = parseBlocks(toCss());
    const sets = Object.keys(themes).map((name) => {
      const props = blocks.get(`[data-theme='${name}']`);
      expect(props).toBeDefined();
      return [...(props?.keys() ?? [])].sort();
    });
    expect(sets[0]).toStrictEqual(sets[1]);
    // Neither ramp carries a derived anchor any more: a surface is a value you
    // can read, in both themes.
    for (const set of sets) expect(set).not.toContain("--bg-l");
  });

  test("theme lowerings preserve solved values and static adapters", () => {
    const css = toCss();
    const blocks = parseBlocks(css);
    for (const [name, theme] of Object.entries(themes)) {
      const props = blocks.get(`[data-theme='${name}']`);
      expect(props?.get("--accent-deep-hover")).toBe(theme.accentHover);
      expect(props?.get("--accent-soft")).toBe(
        `color-mix(in oklab, ${theme.accent} 8%, transparent)`
      );
      expect(props?.get("--bg-hover")).toBe(
        `color-mix(in oklab, ${theme.text} 5%, transparent)`
      );
      expect(props?.get("--bg-press")).toBe(
        `color-mix(in oklab, ${theme.text} 9%, transparent)`
      );
      // Selection is the ONE hue the system reserves, and it is never the
      // accent: the accent is ink, so a selection wash of it would be a grey.
      expect(props?.get("--bg-sel")).toBe(
        "color-mix(in oklab, var(--link) 12%, transparent)"
      );
      expect(props?.get("--link")).toBe(theme.link);
      expect(props?.get("--net")).toBe(theme.net);
      expect(props?.get("--glass-sheen")).toBe(
        theme.sidebarBlur === "none" ? "none" : theme.sidebarBlur
      );
      // 2px of ring at a 2px offset, with the page colour between — which is
      // what makes the ring visible on a FILLED ink button rather than
      // black-on-black.
      expect(props?.get("--focus-ring")).toBe(
        "0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)"
      );
      expect(props?.get("--focus-ring-color")).toBe(theme.ring);
      expect(props?.get("--line-sel")).toBe(
        "color-mix(in oklab, var(--link) 42%, var(--line))"
      );
      expect(props?.get("--on-accent")).toBe("#FDFDFC");
      expect(props?.get("--text-disabled")).toBe(theme.textDisabled);
    }

    const root = blocks.get(":root");
    expect(root?.get("--app-identity-text")).toBe("var(--text)");
    expect(root?.get("--accent")).toBe(BRAND);
    expect(root?.get("--focus-ring")).toBe(
      "0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)"
    );
    expect(root?.get("--target-min")).toBe("44px");
    expect(root?.get("--o-disabled")).toBe("0.45");
    expect(root?.get("--dur-1")).toBe("140ms");
    expect(root?.get("--dur-2")).toBe("280ms");
    expect(
      css.startsWith(
        "/* Generated by @centraid/design — do not edit by hand. */"
      )
    ).toBe(true);
    // A control is 44px on touch without exception, and the control height —
    // 34px, not an off-scale 32 — under a pointer (v7 §C).
    expect(css).toContain(
      "@media (pointer: fine) { :root { --target-min: 34px; } }"
    );
  });

  test("native and blueprint type lowerings preserve the canonical role", () => {
    const nativeBody = nativeTypeStyle(type.body);
    expect(nativeBody.size).toBe(type.body.size + type.body.nativeDelta.size);
    expect(nativeBody.lineHeight).toBe(
      type.body.lineHeight + type.body.nativeDelta.lineHeight
    );

    const blueprintBody = blueprintType.body;
    expect(blueprintTypeShorthand(blueprintBody)).toBe(
      `${blueprintBody.weight} ${blueprintBody.size}/${blueprintBody.lineHeight} var(--font-${blueprintBody.family})`
    );
  });

  test("size rungs lower both pixel and rem scales and deduplicate values", () => {
    expect(
      typeSizeRungs({
        body: { size: 15 },
        bodyStrong: { size: 15 },
        compact: { size: "1rem" },
      })
    ).toStrictEqual({
      "--t-body-size": "15px",
      "--t-compact-size": "1rem",
    });
  });

  test("retired aliases and literals are absent from both generated lowerings", () => {
    const css = `${toCss()}\n${toBlueprintCss()}`;
    expect(css).not.toMatch(
      /--brand\b|--accent-midnight\b|--bezel\b|--font-title\b|--mono\b|--lib-/u
    );
    // The retired teal identity, the retired ramp anchor and the retired type
    // roles. A value flip that leaves one of these behind is a half-flip.
    expect(css).not.toContain("#3EC8B4");
    expect(css).not.toContain("--bg-l");
    expect(css).not.toMatch(/--t-hero\b|--t-greeting\b|--sp-7\b/u);
  });
});
