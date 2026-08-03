// Blueprint CSS lowering.
//
// Blueprint apps share the same role NAMES and now the same VALUES as the
// shell: the Binding Layer has one ink ramp and one paper, and an app surface
// that quietly re-tuned its own greys was the mechanism by which "one product"
// stopped being true. The two remaining blueprint adaptations are real ones —
// host-relative type units (rem, so 200% OS text scale works), and the fact
// that an app owns an identity hue while the shell owns none.
//
// The surface ramp used to be parameterised by `--app-hue`, so every app's
// neutrals leaned toward its own identity. That is retired: `--app-hue` is now
// only the app's slot on the OKLCH identity wheel, and the neutrals are the
// system's literal paper.

import { DENSITY_TIERS, spacing } from "./density";
import { paletteFor, paletteText } from "./palette";
import { radii } from "./radii";
import { emitRecipeCss } from "./recipes/css";
import {
  darkTheme,
  EASE,
  EASE_ENTRY,
  lightTheme,
  SURFACE_TONE_NAMES,
  SURFACE_TONES,
} from "./themes";
import type { Theme } from "./themes";
import {
  blueprintType,
  blueprintTypeShorthand,
  fontStacks,
  type,
  typeKeyToKebab,
  typeModifiers,
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

/** The role cells that flip with the theme — identical in shape for both, so
 *  a role can never exist on one ramp and not the other. */
function themeProps(theme: Theme): Record<string, string> {
  const props: Record<string, string> = {
    "--accent": theme.accent,
    "--accent-deep": theme.accentDeep,
    "--accent-fill": theme.accentDeep,
    "--accent-deep-hover": theme.accentHover,
    "--accent-light": theme.accentLight,
    "--accent-soft": "color-mix(in oklab, var(--accent) 8%, transparent)",
    "--accent-text": theme.accentText,
    "--app-identity": "var(--text)",
    "--app-identity-text": "var(--text)",
    "--bg": theme.bg,
    "--bg-elev": theme.bgElev,
    "--bg-hover": "color-mix(in oklab, var(--text) 5%, transparent)",
    "--bg-press": "color-mix(in oklab, var(--text) 9%, transparent)",
    "--bg-sel": "color-mix(in oklab, var(--link) 12%, transparent)",
    "--bg-sunken": theme.bgSunken,
    "--danger": theme.danger,
    "--focus-ring": "0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)",
    "--focus-ring-color": theme.ring,
    "--line": theme.line,
    "--line-strong": theme.lineStrong,
    "--line-sel": "color-mix(in oklab, var(--link) 42%, var(--line))",
    "--link": theme.link,
    "--net": theme.net,
    "--on-accent": "#FDFDFC",
    "--scrim": theme.scrim,
    "--shadow-lg": theme.shadowLg,
    "--shadow-md": theme.shadowMd,
    "--shadow-sm": theme.shadowSm,
    "--success": theme.success,
    "--text": theme.text,
    "--text-faint": theme.textFaint,
    "--text-ghost": theme.textGhost,
    "--text-inv": theme.textInv,
    "--text-disabled": theme.textDisabled,
    "--text-soft": theme.textSoft,
    "--warning": theme.warning,
  };
  for (const tone of SURFACE_TONE_NAMES) {
    props[`--bg-tone-${tone}`] = SURFACE_TONES[tone][theme.kind];
  }
  for (const [name, value] of Object.entries(paletteFor(theme.kind))) {
    props[`--c-${name}`] = value;
  }
  for (const [name, value] of Object.entries(paletteText[theme.kind])) {
    props[`--c-${name}-text`] = value;
  }
  return props;
}

function lightProps(): Record<string, string> {
  const props: Record<string, string> = {
    // Hue 0 is the wheel origin an app inherits when it declares none; the
    // shipped neutrals no longer read it, so leaving it unset costs nothing.
    "--app-hue": "0",
    "--dur-1": "140ms",
    "--dur-2": "280ms",
    "--ease": EASE,
    "--ease-entry": EASE_ENTRY,
    "--h-control": "34px",
    "--h-row": "44px",
    "--h-segmented": "28px",
    "--density-row": `${DENSITY_TIERS.comfortable.row}px`,
    "--density-pad": `${DENSITY_TIERS.comfortable.pad}px`,
    "--o-disabled": "0.45",
    "--target-min": "44px",
    ...themeProps(lightTheme),
  };
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
  Object.assign(props, typeSizeRungs(blueprintType), typeModifiers(type));
  return props;
}

export function toBlueprintCss(): string {
  const dark = themeProps(darkTheme);
  const darkLines = Object.entries(dark)
    .map(([key, value]) => `    ${key}: ${value};`)
    .join("\n");
  const tones = SURFACE_TONE_NAMES.map((tone) =>
    block(`:root[data-tone='${tone}']`, { "--bg": `var(--bg-tone-${tone})` })
  ).join("\n\n");
  const densities = Object.entries(DENSITY_TIERS)
    .map(([tier, value]) =>
      block(`:root[data-density='${tier}']`, {
        "--density-pad": `${value.pad}px`,
        "--density-row": `${value.row}px`,
      })
    )
    .join("\n\n");
  return [
    "/* Generated by @centraid/design — do not edit by hand. */",
    block(":root", lightProps()),
    emitRecipeCss(":root"),
    block(":root[data-theme='dark']", dark),
    [
      "@media (prefers-color-scheme: dark) {",
      "  :root:not([data-theme]) {",
      darkLines,
      "  }",
      "}",
    ].join("\n"),
    tones,
    densities,
    "@media (pointer: fine) { :root { --target-min: 32px; } }",
    [
      "@media (prefers-reduced-motion: reduce) {",
      "  :where(:root) { --dur-1: 0ms; --dur-2: 0ms; }",
      "  *, *::before, *::after {",
      "    animation-duration: 0s !important;",
      "    animation-iteration-count: 1 !important;",
      "    transition-duration: 0s !important;",
      "  }",
      "}",
    ].join("\n"),
    "/* End generated by @centraid/design — do not edit by hand. */",
    "",
  ].join("\n\n");
}
