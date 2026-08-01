/**
 * Drift guard for the root DESIGN.md brief (#686).
 *
 * DESIGN.md is the machine-readable design brief handed to AI coding agents
 * (getdesign.md convention). It restates exact token values, so it rots the
 * moment someone edits `density.ts` / `radii.ts` / `motion.ts` / `palette.ts` /
 * `themes/shared.ts` without touching it. These tests pin every exact value the
 * brief states against the TypeScript source of truth.
 *
 * Parsing is deliberately minimal: we anchor on token names and assert the
 * source value appears verbatim on the same line. No markdown AST, no table
 * parsing — the brief may be reformatted freely as long as the numbers hold.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { spacing } from "./density.js";
import { EASE } from "./motion.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { themes } from "./themes/index.js";
import { BRAND } from "./themes/shared.js";
import { type } from "./typography.js";

const DESIGN_MD = fileURLToPath(new URL("../../../DESIGN.md", import.meta.url));
const doc = readFileSync(DESIGN_MD, "utf8");

/** Lines mentioning `token`, so a value can be pinned to its own name. */
const linesWith = (token: string): string[] =>
  doc.split("\n").filter((line) => line.includes(token));

describe("DESIGN.md brief", () => {
  test("exists and points at the deeper docs it defers to", () => {
    expect(doc.length).toBeGreaterThan(1000);
    expect(doc).toContain("docs/design-language.md");
    expect(doc).toContain("packages/design/src/contract.ts");
    expect(doc).toContain("getdesign.md");
  });

  test("brand hex matches themes/shared.ts", () => {
    expect(doc).toContain(BRAND);
    expect(linesWith("BRAND").join("\n")).toContain(BRAND);
  });

  test("accent ramp hexes match the shipped light theme", () => {
    for (const [token, value] of [
      ["--accent-light", themes.light.accentLight],
      ["--accent-deep", themes.light.accentDeep],
      ["--accent-midnight", themes.light.accentMidnight],
      ["--accent-text", themes.light.accentText],
    ] as const) {
      expect(linesWith(token).join("\n")).toContain(value);
    }
  });

  test("semantic state colors match both ramps", () => {
    for (const [token, dark, light] of [
      ["--success", themes.dark.success, themes.light.success],
      ["--danger", themes.dark.danger, themes.light.danger],
      ["--warning", themes.dark.warning, themes.light.warning],
    ] as const) {
      const line = linesWith(token).join("\n");
      expect(line).toContain(dark);
      expect(line).toContain(light);
    }
  });

  test("every palette hue is listed by name and hex", () => {
    for (const [name, hex] of Object.entries(palette)) {
      expect(linesWith(name).join("\n")).toContain(hex);
    }
    // and nothing extra was invented
    const listed = [...doc.matchAll(/`--c-(?<hue>[a-z]+)`/gu)].map(
      (m) => m.groups?.hue
    );
    for (const name of listed) {
      expect(Object.keys(palette)).toContain(name);
    }
  });

  test("dark ramp anchor knob matches themes/centraid.ts", () => {
    expect(linesWith("--bg-l").join("\n")).toContain(themes.dark.bgL);
  });

  test("every spacing rung is stated in order", () => {
    const rungs = Object.values(spacing);
    const line = linesWith("--sp-1").join("\n");
    expect(line).toContain(rungs.join(" · "));
    expect(doc).toContain(`--sp-${rungs.length}`);
  });

  test("every radius step is stated with its token", () => {
    for (const [key, value] of Object.entries(radii)) {
      expect(linesWith(`--r-${key}`).join("\n")).toMatch(
        new RegExp(`--r-${key}\`\\s*${value}\\b`, "u")
      );
    }
  });

  test("the easing curve is quoted verbatim", () => {
    expect(linesWith("--ease").join("\n")).toContain(EASE);
    expect(doc).toContain("200ms");
  });

  test("the type scale states each role's size and line-height", () => {
    for (const [key, style] of Object.entries(type)) {
      const token = `--t-${key.replace(/(?<l>[a-z])(?<u>[A-Z])/gu, "$<l>-$<u>").toLowerCase()}`;
      const line = linesWith(token).join("\n");
      expect(line, `${token} missing from DESIGN.md`).not.toBe("");
      expect(line).toContain(`${style.size} / ${style.lineHeight}`);
      expect(line).toContain(style.weight);
    }
  });

  test("typography states roles-not-families and the system stacks", () => {
    expect(doc).toContain("system-ui");
    expect(doc).toContain("ui-monospace");
    expect(doc).toMatch(/Roles, not families/u);
  });

  test("carries the reasoning, not just the values", () => {
    expect(doc).toContain("Field notebook");
    expect(doc).toContain("instrument, not a pillow");
    expect(doc).toMatch(/Neutrals do the work/u);
    expect(doc).toMatch(/measured, not eyeballed/u);
  });
});
