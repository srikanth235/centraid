// DESIGN.md is a checked, normative constitution rather than a prose-only
// document.  The official design.md linter validates the schema; these tests
// pin the value-bearing sections to the TypeScript source of truth.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { paletteText } from "./color.js";
import { spacing } from "./density.js";
import { toNativeTheme } from "./native.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { RECIPE_NAMES } from "./recipes/index.js";
import { themes } from "./themes/index.js";
import {
  ACCENT_DEEP,
  ACCENT_DEEP_DARK,
  ACCENT_LIGHT,
  ACCENT_TEXT_LIGHT,
  BRAND,
  DANGER,
  DANGER_DARK,
  EASE,
  SUCCESS,
  SUCCESS_LIGHT,
  WARNING,
  WARNING_LIGHT,
} from "./themes/shared.js";
import {
  fonts,
  NATIVE_DELTA_BY_FAMILY,
  type,
  typeKeyToKebab,
  typeSizeRungs,
} from "./typography.js";

const DESIGN_MD = fileURLToPath(new URL("../../../DESIGN.md", import.meta.url));
const source = readFileSync(DESIGN_MD, "utf8");
const [frontMatter = "", body = ""] = source.split(/^---$/mu).slice(1);

function frontMatterValue(key: string): string {
  const line = frontMatter
    .split("\n")
    .find((candidate) => new RegExp(`^\\s*${key}:`, "u").test(candidate));
  return (
    line
      ?.split(":")
      .slice(1)
      .join(":")
      .trim()
      .replace(/^['"]|['"]$/gu, "") ?? ""
  );
}

function hasNestedRole(group: string, role: string): boolean {
  const start = frontMatter.indexOf(`${group}:`);
  const end = frontMatter.indexOf("\n---", start);
  return new RegExp(`^ {2}${role}:$`, "mu").test(
    frontMatter.slice(start, end < 0 ? undefined : end)
  );
}

function nestedKeys(group: string): string[] {
  const start = frontMatter.indexOf(`${group}:`);
  const rest = frontMatter.slice(start + group.length + 1);
  const nextGroup = rest.search(/\n(?=[A-Za-z][\w-]*:)/u);
  const end = nextGroup < 0 ? undefined : start + group.length + 1 + nextGroup;
  return [
    ...frontMatter
      .slice(start, end)
      .matchAll(/^ {2}["']?(?<key>[\w-]+)["']?:/gmu),
  ].map((match) => match.groups?.key ?? "");
}

describe("DESIGN.md front matter", () => {
  test("pins identity and the single product accent", () => {
    expect(frontMatterValue("version")).toBe("alpha");
    expect(frontMatterValue("name")).toBe("Centraid");
    expect(frontMatter).toContain(`  brand: "${BRAND}"`);
    expect(frontMatter).toContain(`  accent: "${BRAND}"`);
    expect(frontMatter).toContain('  primary: "{colors.brand}"');
  });

  test("carries the canonical palette and geometry", () => {
    for (const [key, value] of Object.entries(palette)) {
      expect(frontMatter).toContain(`  c-${key}: "${value}"`);
    }
    for (const [key, value] of Object.entries(radii)) {
      expect(frontMatter).toContain(`  ${key}: "${value}px"`);
    }
    for (const [key, value] of Object.entries(spacing)) {
      expect(frontMatter).toContain(`  "${key}": "${value}px"`);
    }
    expect(frontMatter).toContain('  pill: "999px"');
    expect(nestedKeys("rounded")).toStrictEqual(Object.keys(radii));
    expect(nestedKeys("spacing")).toStrictEqual(
      Object.keys(spacing).map(String)
    );
  });

  test("pins every solved color cell and native surface value", () => {
    const expected = {
      brand: BRAND,
      accent: BRAND,
      "accent-light": ACCENT_LIGHT,
      "accent-deep": ACCENT_DEEP,
      "accent-deep-dark": ACCENT_DEEP_DARK,
      "accent-text": ACCENT_TEXT_LIGHT,
      success: SUCCESS_LIGHT,
      "success-dark": SUCCESS,
      danger: DANGER,
      "danger-dark": DANGER_DARK,
      warning: WARNING_LIGHT,
      "warning-dark": WARNING,
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(frontMatterValue(key), key).toBe(value);
    }
    for (const [key, value] of Object.entries(palette)) {
      expect(frontMatterValue(`c-${key}`), `c-${key}`).toBe(value);
      const paletteKey = key as keyof typeof paletteText.light;
      expect(frontMatterValue(`c-${key}-text`)).toBe(
        paletteText.light[paletteKey]
      );
      expect(frontMatterValue(`c-${key}-text-dark`)).toBe(
        paletteText.dark[paletteKey]
      );
    }

    const light = toNativeTheme("light").colors;
    const dark = toNativeTheme("dark").colors;
    for (const [key, value] of Object.entries({
      "light-bg": light.bg,
      "light-bg-app": "#FFFFFF",
      "light-bg-elev": light.bgElev,
      "light-bg-sunken": light.bgSunken,
      "light-text": light.text,
      "light-text-soft": "rgba(20,22,27,0.78)",
      "light-text-faint": "rgba(20,22,27,0.62)",
      "light-text-ghost": "rgba(20,22,27,0.48)",
      "light-text-inv": light.textInv,
      "light-line": "rgba(20,22,27,0.11)",
      "light-line-strong": "rgba(20,22,27,0.20)",
      "dark-bg": dark.bg,
      "dark-bg-app": "#000000",
      "dark-bg-elev": dark.bgElev,
      "dark-bg-sunken": dark.bgSunken,
      "dark-text": dark.text,
      "dark-text-soft": "rgba(236,238,242,0.72)",
      "dark-text-faint": "rgba(236,238,242,0.52)",
      "dark-text-ghost": "rgba(236,238,242,0.38)",
      "dark-text-inv": dark.textInv,
      "dark-line": "rgba(220,230,245,0.08)",
      "dark-line-strong": "rgba(220,230,245,0.16)",
    })) {
      expect(frontMatterValue(key), key).toBe(value);
    }
  });

  test("pins typography deltas and every recipe component", () => {
    for (const [key, style] of Object.entries(type)) {
      const role = typeKeyToKebab(key);
      expect(frontMatter).toContain(`  ${role}:`);
      expect(frontMatter).toContain(`    fontFamily: "${fonts[style.family]}"`);
      expect(frontMatter).toContain(`    fontSize: "${style.size}px"`);
      expect(frontMatter).toContain(`    fontWeight: "${style.weight}"`);
      expect(frontMatter).toContain(`    lineHeight: "${style.lineHeight}px"`);
      expect(style.nativeDelta).toStrictEqual(
        NATIVE_DELTA_BY_FAMILY[style.family]
      );
    }
    for (const name of RECIPE_NAMES) {
      expect(hasNestedRole("components", name), name).toBe(true);
    }
  });

  test("pins every type role and profile-specific support is in the body", () => {
    for (const [key, style] of Object.entries(type)) {
      expect(hasNestedRole("typography", typeKeyToKebab(key))).toBe(true);
      expect(body).toContain(`--t-${typeKeyToKebab(key)}`);
      expect(body).toContain(`${style.size} / ${style.lineHeight}`);
      expect(body).toContain(style.weight);
      expect(body).toContain(fonts[style.family]);
    }
    expect(body).toContain("Mobile maps those genera to loaded");
    expect(body).toContain("nativeDelta");
    expect(body).toContain("`--bg-l: 5%`");
    expect(body).toContain("`--bg-l: 10%`");
  });

  test("pins the solved theme values", () => {
    expect(frontMatter).toContain(`  light-bg: "${themes.light.bg}"`);
    expect(frontMatter).toContain(`  light-text: "${themes.light.text}"`);
    expect(frontMatter).toContain(`  dark-text: "${themes.dark.text}"`);
    expect(frontMatter).toContain(`  dark-line: "${themes.dark.line}"`);
  });
});

describe("DESIGN.md body", () => {
  test("uses the canonical sections plus the two local grammar sections", () => {
    const canonical = [
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Responsive Behavior",
      "Agent Prompt Guide",
      "Do's and Don'ts",
    ];
    const present = [...body.matchAll(/^## (?<title>.+)$/gmu)].map(
      (match) => match.groups?.title?.trim() ?? ""
    );
    expect(present).toStrictEqual(canonical);
  });

  test("documents the one contract and all five laws", () => {
    expect(body.length).toBeGreaterThan(7000);
    expect(body).toContain("docs/traps/design-tokens.md");
    expect(body).toContain("packages/design/src/roles.ts");
    expect(body).toContain("packages/design/src/recipes/index.ts");
    expect(body).toContain("Accent is a word, not a slot");
    expect(body).toContain("at most one accent-filled action");
    expect(body).toContain("renderer never chooses foreground");
  });

  test("documents every composable size rung and the deduplication law", () => {
    for (const [name, value] of Object.entries(typeSizeRungs(type))) {
      expect(body).toContain(`\`${name}\` ${value}`);
    }
    expect(body).toContain("`--t-body-strong-size` does not exist");
    expect(body).toContain("There are no line-height rungs");
  });

  test("quotes the motion and responsive accessibility contracts", () => {
    expect(body).toContain(EASE);
    expect(body).toContain("200ms");
    expect(body).toContain("44px");
    expect(body).toContain("48dp");
    expect(body).toContain("720px");
  });

  test("names the deeper docs and machine checks", () => {
    expect(body).toContain("google-labs-code/design.md");
    expect(body).toContain("bun run lint:design-md");
    expect(body).toContain("bun run check:pr");
  });
});
