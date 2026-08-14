import { describe, expect, test } from "vitest";

import { toCss } from "./css.js";
import { palette } from "./palette.js";
import { radii } from "./radii.js";
import { BRAND, BRAND_DARK, themes } from "./themes/index.js";

const css = toCss();

function blockFor(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no block for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
}

describe("shell CSS lowering", () => {
  test("emits the identity ring, radii and the ink accent under canonical names", () => {
    const root = blockFor(":root");
    for (const [key, value] of Object.entries(palette)) {
      expect(root).toContain(`--c-${key}: ${value};`);
    }
    for (const [key, value] of Object.entries(radii)) {
      expect(root).toContain(`--r-${key}: ${value}px;`);
    }
    // The load-bearing literal of the whole system: the action colour is INK.
    // If a hue ever reappears here, every app identity colour stops meaning
    // "this belongs to that app", and nothing else in the tree would notice.
    expect(root).toContain(`--accent: ${BRAND};`);
    expect(root).toContain(`--accent-fill: ${BRAND};`);
    expect(root).toContain("--target-min: 44px;");
  });

  test("emits the component metrics and both motion cases", () => {
    const root = blockFor(":root");
    expect(root).toContain("--h-control: 34px;");
    expect(root).toContain("--h-row: 44px;");
    expect(root).toContain("--h-segmented: 28px;");
    expect(root).toContain("--w-stem: 240px;");
    expect(root).toContain("--dur-1: 140ms;");
    expect(root).toContain("--dur-2: 280ms;");
    expect(root).toContain("--ease: cubic-bezier(0.3, 0, 0.4, 1);");
    expect(root).toContain("--ease-entry: cubic-bezier(0.2, 0.7, 0.2, 1);");
  });

  test("emits the desktop app-mark tint contract", () => {
    expect(blockFor(":root")).toContain("--app-mark-tint: 13%;");
    expect(blockFor("[data-theme='dark']")).toContain("--app-mark-tint: 20%;");
  });

  test("follows the OS until `data-theme` is stamped", () => {
    // The un-stamped first paint has to be able to be LIGHT. While this block
    // was missing, the shell's index.html hardcoded `data-theme="dark"` to
    // avoid a light flash before the renderer read the member's prefs — and a
    // hardcoded attribute always beats a preference, so "follow the system"
    // could not be honoured at all. The blueprint sheet has emitted this pair
    // since it shipped; this is the shell catching up.
    const fallback = blockFor(":root:not([data-theme])");
    expect(css).toContain("@media (prefers-color-scheme: dark) {");
    expect(fallback).toContain(`--bg: ${themes.dark.bg};`);
    expect(fallback).toContain(`--text: ${themes.dark.text};`);
    // `:not([data-theme])` stops matching the moment the attribute exists, so
    // an explicit pick — including `light` on a dark machine — still wins.
    expect(blockFor("[data-theme='light']")).toContain(
      `--bg: ${themes.light.bg};`
    );
  });

  test("puts the density axis on an attribute, and emits no tone axis", () => {
    // An app declares a density tier; ONLY row height and content padding
    // move. A control below 34px stops being hittable, so control size is
    // not on this axis. There is no surface-tone axis at all — one page, for
    // the shell and every app in it.
    expect(css).not.toContain("data-tone");
    expect(css).not.toContain("--bg-tone");
    expect(css).toContain("[data-density='compact'] {");
    expect(css).toContain("[data-density='dense'] {");
    const dense = blockFor("[data-density='dense']");
    expect(dense).toContain("--density-row: 34px;");
    expect(dense).not.toContain("--h-control");
  });

  test("honours reduced motion in exactly one global rule", () => {
    expect(css.split("@media (prefers-reduced-motion: reduce)")).toHaveLength(
      2
    );
    expect(css).toContain("--dur-1: 0ms; --dur-2: 0ms;");
    expect(css).toContain("transition-duration: 0s !important;");
  });

  test("emits lower-case role names and no retired aliases", () => {
    const root = blockFor(":root");
    expect(root).toContain("--t-body-strong:");
    expect(root).toContain("--t-small-strong:");
    expect(root).not.toMatch(/--t-[a-z-]*[A-Z]/u);
    expect(root).not.toMatch(/--brand\b|--font-title\b|--mono\b|--lib-/u);
  });

  test("emits each theme as literal paper, with no derived surface anchor", () => {
    for (const name of Object.keys(themes)) {
      expect(css).toContain(`[data-theme='${name}'] {`);
    }
    const dark = blockFor("[data-theme='dark']");
    // The dark ramp is warm-tinted paper now (`#171716`, not `hsl(0 0% 9%)`),
    // which the old one-knob greyscale calc could not express. The knob is
    // gone rather than faked with a saturation parameter.
    expect(dark).toContain(`--accent: ${BRAND_DARK};`);
    expect(dark).toContain("--bg: #0E0E0E;");
    expect(dark).toContain("--bg-elev: #171716;");
    expect(css).not.toContain("--bg-l");
    expect(dark).not.toContain("calc(");
  });

  test("is a balanced generated stylesheet", () => {
    expect(css.startsWith("/* Generated by @centraid/design")).toBe(true);
    expect(css.endsWith("\n")).toBe(true);
    expect(css.split("{")).toHaveLength(css.split("}").length);
  });
});
