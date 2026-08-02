// Blueprint CSS lowering.
//
// Blueprint apps share the same role names as the shell.  App identity is an
// explicit `--app-identity` value; it never shadows the product accent used
// for actions and selection.  The only blueprint adaptation is host-relative
// type units and the app-neutral surface ramp.

import { paletteText, semanticShade } from "./color";
import { spacing } from "./density";
import { palette } from "./palette";
import { radii } from "./radii";
import { ACCENT_TEXT_LIGHT, BRAND, EASE } from "./themes";
import {
  blueprintType,
  blueprintTypeShorthand,
  fontStacks,
  typeKeyToKebab,
  typeSizeRungs,
} from "./typography";

function block(selector: string, props: Record<string, string>): string {
  const lines: string[] = [`${selector} {`];
  for (const [key, value] of Object.entries(props)) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function lightProps(): Record<string, string> {
  const props: Record<string, string> = {
    "--accent": BRAND,
    "--accent-deep": "#22776B",
    "--accent-fill": "#22776B",
    "--accent-deep-hover": "#1D685E",
    "--accent-light": "#62D6C6",
    "--accent-soft": "rgba(62,200,180,.12)",
    "--accent-text": "#0F7A6C",
    "--app-hue": "171",
    "--app-identity": BRAND,
    "--app-identity-text": ACCENT_TEXT_LIGHT,
    "--bg": "hsl(var(--app-hue) 20% 98%)",
    "--bg-elev": "#FFFFFF",
    "--bg-hover": "color-mix(in oklab, var(--text) 5%, transparent)",
    "--bg-press": "color-mix(in oklab, var(--text) 9%, transparent)",
    "--bg-sel": "color-mix(in oklab, var(--accent) 12%, transparent)",
    "--bg-sunken": "hsl(var(--app-hue) 20% 95.5%)",
    "--danger": semanticShade("#c8382f", "blueprintLight"),
    "--ease": EASE,
    "--focus-ring": "0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent)",
    "--focus-ring-color": BRAND,
    "--line": "hsl(var(--app-hue) 19% 13% / .095)",
    "--line-strong": "hsl(var(--app-hue) 19% 13% / .165)",
    "--line-sel": "color-mix(in oklab, var(--accent) 42%, var(--line))",
    "--on-accent": "#141820",
    "--o-disabled": "0.45",
    "--scrim": "hsl(var(--app-hue) 22% 8% / .48)",
    "--shadow-lg": "0 26px 60px -24px hsl(var(--app-hue) 30% 9% / .39)",
    "--shadow-md": "0 10px 26px -14px hsl(var(--app-hue) 30% 9% / .27)",
    "--shadow-sm": "0 1px 2px hsl(var(--app-hue) 30% 9% / .12)",
    "--success": semanticShade("#2f7d4f", "blueprintLight"),
    "--target-min": "44px",
    "--text": "hsl(var(--app-hue) 22% 12%)",
    "--text-faint": "hsl(var(--app-hue) 8% 42%)",
    "--text-ghost": "hsl(var(--app-hue) 8% 52%)",
    "--text-inv": "#FFFFFF",
    "--text-disabled": "hsl(var(--app-hue) 8% 58%)",
    "--text-soft": "hsl(var(--app-hue) 9% 36%)",
    "--warning": semanticShade("#9a6b1f", "blueprintLight"),
    "--dur-1": "120ms",
    "--dur-2": "200ms",
  };
  for (const [name, value] of Object.entries(palette)) {
    props[`--c-${name}`] = value;
  }
  for (const [name, value] of Object.entries(paletteText.light)) {
    props[`--c-${name}-text`] = value;
  }
  for (const [key, value] of Object.entries(radii)) {
    props[`--r-${key}`] = `${value}px`;
  }
  for (const [key, value] of Object.entries(spacing)) {
    props[`--sp-${key}`] = `${value}px`;
  }
  for (const [key, value] of Object.entries(fontStacks)) {
    props[`--font-${key}`] = value;
  }
  for (const [key, value] of Object.entries(blueprintType)) {
    props[`--t-${typeKeyToKebab(key)}`] = blueprintTypeShorthand(value);
  }
  Object.assign(props, typeSizeRungs(blueprintType));
  return props;
}

function darkProps(): Record<string, string> {
  const props: Record<string, string> = {
    "--accent-deep": "#34B7A4",
    "--accent-fill": "#34B7A4",
    "--accent-deep-hover": "#4BC3B2",
    "--accent-text": "#3EC8B4",
    "--app-identity-text": BRAND,
    "--bg": "hsl(0 0% var(--bg-l))",
    "--bg-elev": "hsl(0 0% calc(var(--bg-l) + 5%))",
    "--bg-sunken": "hsl(0 0% calc(var(--bg-l) + 9%))",
    "--bg-l": "10%",
    "--danger": semanticShade("#f0645b", "blueprintDark"),
    "--line": "hsl(0 0% 76% / .11)",
    "--line-strong": "hsl(0 0% 76% / .2)",
    "--line-sel": "color-mix(in oklab, var(--accent) 42%, var(--line))",
    "--scrim": "hsl(0 0% 0% / .68)",
    "--shadow-lg": "0 30px 70px -24px rgba(0,0,0,.7)",
    "--shadow-md": "0 12px 30px -14px rgba(0,0,0,.6)",
    "--success": semanticShade("#5cc98a", "blueprintDark"),
    "--text": "hsl(0 0% 94%)",
    "--text-faint": "hsl(0 0% 60%)",
    "--text-ghost": "hsl(0 0% 68%)",
    "--text-inv": "hsl(0 0% calc(var(--bg-l) + 4%))",
    "--text-disabled": "hsl(0 0% 72%)",
    "--text-soft": "hsl(0 0% 66%)",
    "--warning": semanticShade("#e0a94a", "blueprintDark"),
  };
  for (const [name, value] of Object.entries(paletteText.dark)) {
    props[`--c-${name}-text`] = value;
  }
  return props;
}

export function toBlueprintCss(): string {
  const dark = darkProps();
  const darkLines = Object.entries(dark)
    .map(([key, value]) => `    ${key}: ${value};`)
    .join("\n");
  return [
    "/* Generated by @centraid/design — do not edit by hand. */",
    block(":root", lightProps()),
    block(":root[data-theme='dark']", dark),
    [
      "@media (prefers-color-scheme: dark) {",
      "  :root:not([data-theme]) {",
      darkLines,
      "  }",
      "}",
    ].join("\n"),
    "@media (pointer: fine) { :root { --target-min: 32px; } }",
    "",
  ].join("\n\n");
}
