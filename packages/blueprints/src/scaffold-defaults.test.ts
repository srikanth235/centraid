/**
 * Snapshot-style tests naming scaffold-defaults.ts (issue #545 B13).
 */

import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_README,
  DEFAULT_APP_CSS,
  README_TEMPLATE,
} from "./scaffold-defaults.js";

/** The sheet with comments stripped — a documented "was #fff" note in prose
 * must never read as a live declaration. */
const CSS = DEFAULT_APP_CSS.replace(/\/\*[\s\S]*?\*\//gu, "");

/** Every spacing declaration in the sheet, as `[property, value]`. */
function spacingDecls(): Array<[string, string]> {
  const re =
    /(?<prop>(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?)\s*:\s*(?<value>[^;}]+)/gu;
  return [...CSS.matchAll(re)].map((m) => [
    m.groups?.prop ?? "",
    (m.groups?.value ?? "").trim(),
  ]);
}

describe("scaffold-defaults", () => {
  it("DEFAULT_APP_CSS is a design-token-driven stylesheet (no color literals)", () => {
    expect(DEFAULT_APP_CSS).toContain("--app-hue");
    expect(DEFAULT_APP_CSS).toContain("--accent");
    expect(DEFAULT_APP_CSS).toContain("prefers-reduced-motion");
    expect(DEFAULT_APP_CSS).toContain("720px");
    expect(DEFAULT_APP_CSS).toContain("var(--bg-sel)");
    expect(DEFAULT_APP_CSS).toContain("var(--focus-ring-color)");
    // Colors come from CSS vars only — the old `var(--text-inv, #fff)`
    // carve-out is gone now that `--text-inv` is in the token contract.
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(CSS).not.toMatch(/\b(?:rgba?|hsla?)\(/u);
    expect(DEFAULT_APP_CSS).toMatchSnapshot();
  });

  // #686 A3: kit.css is served to every app surface, so the scaffold must not
  // ship a parallel component vocabulary next to `.kit-*`.
  it("DEFAULT_APP_CSS carries no second spelling of a kit component", () => {
    for (const retired of [
      ".primary",
      ".ghost",
      ".link",
      ".del",
      ".muted",
      ".small",
      ".empty",
    ]) {
      expect(CSS, `retired class ${retired}`).not.toContain(`${retired} {`);
      expect(CSS, `retired class ${retired}`).not.toContain(`${retired},`);
    }
    // Knob overrides of kit classes must be compound selectors — kit.css
    // loads after app.css, so an equal-specificity rule would lose.
    expect(CSS).toContain(":root[data-app-radius='pill'] .kit-btn");
    expect(CSS).not.toMatch(/^\s*\.kit-[a-z-]+\s*\{/mu);
  });

  // #686 A4: every size in the sheet comes from the token contract.
  it("DEFAULT_APP_CSS declares no raw font-size", () => {
    expect(CSS).not.toMatch(/font-size\s*:/u);
    expect(CSS).toContain("font: var(--t-body)");
    expect(CSS).toContain("font: var(--t-title)");
  });

  it("DEFAULT_APP_CSS spaces only on the --sp-* rungs", () => {
    const decls = spacingDecls();
    expect(decls.length).toBeGreaterThan(8);
    for (const [prop, value] of decls) {
      // Strip the legal wrappers, then nothing with a length unit may remain.
      const residue = value
        .replace(/var\(--sp-\d\)/gu, "")
        .replace(/env\([a-z-]+\)/gu, "")
        .replace(/\b(?:max|min|calc)\(/gu, "")
        .replace(/[(),]/gu, " ");
      expect(residue, `${prop}: ${value}`).not.toMatch(
        /\d*\.?\d+\s*(?:px|rem|em|ch|vh|vw)/u
      );
    }
  });

  it("README_TEMPLATE interpolates the app id into layout paths", () => {
    const md = README_TEMPLATE("todos");
    expect(md).toMatch(/^# todos\n/u);
    expect(md).toContain("/centraid/todos/");
    expect(md).toContain("app.json");
    expect(md).toContain("automations/");
    expect(md).toMatchSnapshot();
  });

  it("AUTOMATIONS_README documents the per-automation folder shape", () => {
    expect(AUTOMATIONS_README).toContain("automation.json");
    expect(AUTOMATIONS_README).toContain("handler.js");
    expect(AUTOMATIONS_README).toMatchSnapshot();
  });
});
