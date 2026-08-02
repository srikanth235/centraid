import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { paletteText } from "./color.js";
import { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract.js";
import { toCss } from "./css.js";
import { spacing } from "./density.js";
import { library } from "./library.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { BRAND, themes } from "./themes/index.js";
import {
  blueprintType,
  blueprintTypeShorthand,
  nativeTypeStyle,
  type,
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
      expect(
        root?.get(
          `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`
        )
      ).toContain(`${value.size}px/${value.lineHeight}px`);
      expect(value.nativeDelta.size).toBeGreaterThan(0);
      expect(value.nativeDelta.lineHeight).toBeGreaterThan(0);
    }
    const rungs = typeSizeRungs(type);
    expect(Object.keys(rungs)).toContain("--t-body-size");
    expect(Object.keys(rungs)).not.toContain("--t-body-strong-size");
  });

  test("every theme has the same solved roles and the dark anchor is explicit", () => {
    const blocks = parseBlocks(toCss());
    const sets = Object.keys(themes).map((name) => {
      const props = blocks.get(`[data-theme='${name}']`);
      expect(props).toBeDefined();
      return [...(props?.keys() ?? [])]
        .filter((key) => key !== "--bg-l")
        .sort();
    });
    expect(sets[0]).toStrictEqual(sets[1]);
    expect(blocks.get("[data-theme='dark']")?.has("--bg-l")).toBe(true);
    expect(blocks.get("[data-theme='light']")?.has("--bg-l")).toBe(false);
  });

  test("theme lowerings preserve solved values and static adapters", () => {
    const css = toCss();
    const blocks = parseBlocks(css);
    for (const [name, theme] of Object.entries(themes)) {
      const props = blocks.get(`[data-theme='${name}']`);
      expect(props?.get("--accent-deep-hover")).toBe(
        `color-mix(in oklab, ${theme.accentDeep} 88%, ${theme.text} 12%)`
      );
      expect(props?.get("--accent-soft")).toBe(
        `color-mix(in oklab, ${theme.accent} 12%, transparent)`
      );
      expect(props?.get("--bg-hover")).toBe(
        `color-mix(in oklab, ${theme.text} 5%, transparent)`
      );
      expect(props?.get("--bg-press")).toBe(
        `color-mix(in oklab, ${theme.text} 9%, transparent)`
      );
      expect(props?.get("--bg-sel")).toBe(
        "color-mix(in oklab, var(--accent) 12%, transparent)"
      );
      expect(props?.get("--glass-sheen")).toBe(
        theme.sidebarBlur === "none" ? "none" : theme.sidebarBlur
      );
      expect(props?.get("--focus-ring")).toBe(
        "0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent)"
      );
      expect(props?.get("--line-sel")).toBe(
        "color-mix(in oklab, var(--accent) 42%, var(--line))"
      );
      expect(props?.get("--on-accent")).toBe("#141820");
      expect(props?.get("--text-disabled")).toBe(
        `color-mix(in oklab, ${theme.text} 36%, ${theme.bg})`
      );
    }

    const root = blocks.get(":root");
    expect(root?.get("--app-identity-text")).toBe(paletteText.light.teal);
    expect(root?.get("--accent")).toBe(BRAND);
    expect(root?.get("--focus-ring")).toBe(
      "0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent)"
    );
    expect(root?.get("--target-min")).toBe("44px");
    expect(root?.get("--o-disabled")).toBe("0.45");
    expect(root?.get("--dur-1")).toBe("120ms");
    expect(root?.get("--dur-2")).toBe("200ms");
    expect(
      css.startsWith(
        "/* Generated by @centraid/design — do not edit by hand. */"
      )
    ).toBe(true);
    expect(css).toContain(
      "@media (pointer: fine) { :root { --target-min: 32px; } }"
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
    expect(css).not.toContain("#128A78");
  });
});
