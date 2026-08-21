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

import {
  DENSITY_TIERS,
  metrics,
  pageMargin,
  spacing,
  subBase,
} from "./density";
import { paletteFor, paletteText } from "./palette";
import { radii } from "./radii";
import {
  darkTheme,
  EASE,
  EASE_ENTRY,
  lightTheme,
  ON_STAGE,
  ON_STAGE_SOFT,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
} from "./themes";
import type { Theme } from "./themes";
import {
  blueprintType,
  blueprintTypeForSurface,
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
    "--accent-hover": theme.accentInkHover,
    "--accent-light": theme.accentLight,
    "--accent-soft": "color-mix(in oklab, var(--accent) 8%, transparent)",
    "--accent-text": theme.accentText,
    "--attention": theme.attention,
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
    "--net-hover": theme.netHover,
    "--net-wash": theme.netWash,
    "--on-accent": theme.textInv,
    "--seam": theme.seam,
    // The media stage is fixed across themes; its foreground is too.
    "--on-stage": ON_STAGE,
    "--on-stage-soft": ON_STAGE_SOFT,
    "--scrim": theme.scrim,
    "--shadow-lg": theme.shadowLg,
    "--shadow-md": theme.shadowMd,
    "--shadow-sm": theme.shadowSm,
    "--skel": theme.skel,
    "--stage": STAGE,
    "--stage-line": STAGE_LINE,
    "--stage-sunken": STAGE_SUNKEN,
    "--success": theme.success,
    "--text": theme.text,
    "--text-faint": theme.textFaint,
    "--text-ghost": theme.textGhost,
    "--text-inv": theme.textInv,
    "--text-disabled": theme.textDisabled,
    "--text-soft": theme.textSoft,
    "--warning": theme.warning,
  };
  for (const [name, value] of Object.entries(paletteFor(theme.kind))) {
    props[`--c-${name}`] = value;
  }
  for (const [name, value] of Object.entries(paletteText[theme.kind])) {
    props[`--c-${name}-text`] = value;
  }
  return props;
}

function lightProps(): Record<string, string> {
  const touchType = blueprintTypeForSurface(true);
  const props: Record<string, string> = {
    // Hue 0 is the wheel origin an app inherits when it declares none; the
    // shipped neutrals no longer read it, so leaving it unset costs nothing.
    "--app-hue": "0",
    "--dur-1": "140ms",
    "--dur-2": "280ms",
    "--ease": EASE,
    "--ease-entry": EASE_ENTRY,
    // From `metrics`, never re-typed — the shell sheet reads the same three.
    "--h-control": `${metrics.control}px`,
    "--h-row": `${metrics.row}px`,
    "--h-segmented": `${metrics.segmented}px`,
    "--density-row": `${DENSITY_TIERS.comfortable.row}px`,
    "--density-pad": `${DENSITY_TIERS.comfortable.pad}px`,
    "--o-disabled": "0.45",
    // An app draws its own pages, so it needs the margin the rest of the
    // product uses. Without it a blueprint has to invent a number, and Photos
    // did — 20px, which is neither rung.
    "--page-margin": `${pageMargin.mobile}px`,
    "--target-min": `${metrics.controlTouch}px`,
    ...themeProps(lightTheme),
  };
  for (const [key, value] of Object.entries(radii)) {
    props[`--r-${key}`] = `${value}px`;
  }
  for (const [key, value] of Object.entries(spacing)) {
    props[`--sp-${key}`] = `${value}px`;
  }
  // The two named sub-base seams (v7 §E) — same namespace, same reason as the
  // shell sheet: an app pane may not invent a third value under the base.
  for (const [key, value] of Object.entries(subBase)) {
    props[`--sp-${key}`] = `${value}px`;
  }
  for (const [key, value] of Object.entries(fontStacks)) {
    props[`--font-${key}`] = value;
  }
  for (const [key, value] of Object.entries(touchType)) {
    props[`--t-${typeKeyToKebab(key)}`] = blueprintTypeShorthand(value);
  }
  Object.assign(props, typeSizeRungs(touchType), typeModifiers(type));
  return props;
}

export function toBlueprintCss(): string {
  const dark = themeProps(darkTheme);
  const darkLines = Object.entries(dark)
    .map(([key, value]) => `    ${key}: ${value};`)
    .join("\n");
  const densities = Object.entries(DENSITY_TIERS)
    .map(([tier, value]) =>
      block(`:root[data-density='${tier}']`, {
        "--density-pad": `${value.pad}px`,
        "--density-row": `${value.row}px`,
      })
    )
    .join("\n\n");
  const pointerProps: Record<string, string> = {
    "--page-margin": `${pageMargin.desktop}px`,
    "--target-min": `${metrics.control}px`,
  };
  for (const [key, value] of Object.entries(blueprintType)) {
    pointerProps[`--t-${typeKeyToKebab(key)}`] = blueprintTypeShorthand(value);
  }
  Object.assign(pointerProps, typeSizeRungs(blueprintType));
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
    densities,
    // Same one axis as the shell sheet — 44 on touch, `metrics.control` under
    // a pointer (v7 §C). See css.ts for why 32px was not a rung.
    [
      "@media (pointer: fine) {",
      block(":root", pointerProps)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      "}",
    ].join("\n"),
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
