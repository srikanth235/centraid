// DESIGN.md is a checked, normative constitution rather than a prose-only
// document.  The official design.md linter validates the schema; these tests
// pin the value-bearing sections to the TypeScript source of truth.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { spacing } from "./density.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { themes } from "./themes/index.js";
import { BRAND, EASE } from "./themes/shared.js";
import { fonts, type, typeKeyToKebab, typeSizeRungs } from "./typography.js";

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
  return new RegExp(`^  ${role}:$`, "mu").test(
    frontMatter.slice(start, end < 0 ? undefined : end)
  );
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
