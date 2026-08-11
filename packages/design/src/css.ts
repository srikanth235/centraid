// Shell CSS lowering for the product-grammar registry.
//
// This is the only place that turns shared design values into a browser
// custom-property sheet.  It deliberately emits solved values and adapters;
// clients do not need a CSS parser or a second semantic vocabulary.
//
// Two things this file owns that no component may re-own:
//   • the density axis — an app sets `data-density`, and only row height and
//     content padding move (never control size);
//   • `prefers-reduced-motion`, honoured in ONE global rule.
//
// There is no surface-tone axis. The shell and every app share ONE page
// colour (`--bg`); see docs/traps/design-tokens.md, "There is ONE page, and
// an app does not retune it."

import { DENSITY_TIERS, metrics, pageMargin, spacing } from "./density";
import { library } from "./library";
import { paletteFor, paletteText } from "./palette";
import { radii } from "./radii";
import { emitRecipeCss } from "./recipes/css";
import {
  EASE,
  EASE_ENTRY,
  ON_STAGE,
  ON_STAGE_SOFT,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
  themes,
} from "./themes";
import type { Theme, ThemeName } from "./themes";
import {
  fontStacks,
  remSizeScale,
  type,
  typeKeyToKebab,
  typeModifiers,
  typeShorthand,
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

function themeProps(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {
    "--accent": theme.accent,
    "--accent-deep": theme.accentDeep,
    "--accent-fill": theme.accentDeep,
    "--accent-deep-hover": theme.accentHover,
    "--accent-light": theme.accentLight,
    "--accent-soft": `color-mix(in oklab, ${theme.accent} 8%, transparent)`,
    "--accent-text": theme.accentText,
    // An app that declares no identity renders in ink; the shell always does.
    "--app-identity-text": "var(--text)",
    "--bg": theme.bg,
    "--bg-app": theme.bgApp,
    "--bg-chrome": theme.sidebarBg,
    "--bg-elev": theme.bgElev,
    "--bg-hud":
      theme.kind === "dark" ? "rgba(14,14,14,.94)" : "rgba(253,253,252,.94)",
    "--bg-hover": `color-mix(in oklab, ${theme.text} 5%, transparent)`,
    "--bg-press": `color-mix(in oklab, ${theme.text} 9%, transparent)`,
    "--bg-sel": "color-mix(in oklab, var(--link) 12%, transparent)",
    "--bg-sunken": theme.bgSunken,
    "--bg-wall": theme.bgWall,
    "--danger": theme.danger,
    "--device-wall": theme.deviceWall,
    "--glass-film": theme.sidebarBg,
    "--glass-sheen": theme.sidebarBlur,
    "--focus-ring": "0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)",
    "--focus-ring-color": theme.ring,
    "--line": theme.line,
    "--line-strong": theme.lineStrong,
    "--line-sel": "color-mix(in oklab, var(--link) 42%, var(--line))",
    "--link": theme.link,
    "--net": theme.net,
    "--on-accent": "#FDFDFC",
    // The stage is the media ground for viewer/slideshow/editor — deliberately
    // the SAME literal in both themes (Photos handoff v4 §B), unlike every
    // other role in this block.
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
  for (const [key, value] of Object.entries(paletteFor(theme.kind))) {
    out[`--c-${key}`] = value;
  }
  for (const [key, value] of Object.entries(paletteText[theme.kind])) {
    out[`--c-${key}-text`] = value;
  }
  return out;
}

/** The density axis. Tiers scale row height and content padding only — a
 *  control below 34px stops being reliably hittable, so control size is not
 *  on this axis and no tier may put it there. */
function densityBlocks(): string {
  return Object.entries(DENSITY_TIERS)
    .map(([tier, value]) =>
      block(`[data-density='${tier}']`, {
        "--density-pad": `${value.pad}px`,
        "--density-row": `${value.row}px`,
      })
    )
    .join("\n\n");
}

/** Reduced motion, honoured in ONE place. Duration goes to zero and nothing
 *  else changes: the grammar says movement is removed, not that layout is. */
const REDUCED_MOTION = [
  "@media (prefers-reduced-motion: reduce) {",
  "  :where(html) { --dur-1: 0ms; --dur-2: 0ms; }",
  "  *, *::before, *::after {",
  "    animation-duration: 0s !important;",
  "    animation-iteration-count: 1 !important;",
  "    transition-duration: 0s !important;",
  "  }",
  "}",
].join("\n");

export function toCss(): string {
  const staticProps: Record<string, string> = {};
  for (const [key, value] of Object.entries(radii))
    staticProps[`--r-${key}`] = `${value}px`;
  for (const [key, value] of Object.entries(spacing))
    staticProps[`--sp-${key}`] = `${value}px`;

  staticProps["--ease"] = EASE;
  staticProps["--ease-entry"] = EASE_ENTRY;
  staticProps["--target-min"] = "44px";
  staticProps["--o-disabled"] = "0.45";
  staticProps["--dur-1"] = "140ms";
  staticProps["--dur-2"] = "280ms";
  // From `metrics`, never re-typed: these same four numbers are emitted to
  // native by `roles.ts` and quoted in DESIGN.md, and a literal here is how the
  // CSS and the native lowering drift apart without a test noticing.
  staticProps["--h-control"] = `${metrics.control}px`;
  staticProps["--h-row"] = `${metrics.row}px`;
  staticProps["--h-segmented"] = `${metrics.segmented}px`;
  staticProps["--w-stem"] = `${metrics.stem}px`;
  // THE PAGE MARGIN, emitted so the web stops guessing it. Native already
  // reads this scale (`toNativeTheme` lowers the mobile rung) and every phone
  // screen insets by it; the web had no token at all, so blueprints hardcoded
  // their own number — Photos used 20px, which is neither the desktop 32 nor
  // the mobile 18. The compact rung is not a media query here because an app
  // pane can be narrower than the viewport (#505 trap 1); a pane that knows it
  // is narrow re-declares this property on itself and everything inside it
  // follows, which is why the value is read through a variable rather than
  // branched on at each use.
  staticProps["--page-margin"] = `${pageMargin.desktop}px`;
  staticProps["--page-margin-compact"] = `${pageMargin.mobile}px`;
  staticProps["--density-row"] = `${DENSITY_TIERS.comfortable.row}px`;
  staticProps["--density-pad"] = `${DENSITY_TIERS.comfortable.pad}px`;
  for (const [key, value] of Object.entries(fontStacks))
    staticProps[`--font-${key}`] = value;
  for (const [key, value] of Object.entries(type)) {
    staticProps[`--t-${typeKeyToKebab(key)}`] = typeShorthand(value);
  }
  Object.assign(
    staticProps,
    typeSizeRungs(remSizeScale(type)),
    typeModifiers(type)
  );

  // Library became a tile recipe.  The values stay shared between Home and
  // Discover, but the semantic namespace no longer suggests a separate UI.
  for (const [key, value] of Object.entries(library)) {
    const suffix = key.startsWith("tile-") ? key.slice("tile-".length) : key;
    staticProps[`--tile-${suffix}`] = value;
  }

  // The `prefers-color-scheme` entry is the un-stamped first paint. `<html>`
  // carries no `data-theme` until the renderer has read the member's prefs, and
  // until this existed the shell's index.html hardcoded `data-theme="dark"` to
  // stop a light flash — which made "follow the system" unreachable, because
  // the attribute always won. The blueprint sheet has emitted exactly this pair
  // since it shipped (`blueprint.ts`), and `skills/ui-grounding.ts` already
  // TELLS app authors the token baseline handles both; the shell sheet was the
  // asymmetry.
  //
  // No specificity contest with the `[data-theme='…']` blocks appended below:
  // `:not([data-theme])` simply stops matching the moment the attribute is
  // stamped, so an explicit choice — including an explicit `light` on a dark
  // OS — always wins.
  const blocks = [
    "/* Generated by @centraid/design — do not edit by hand. */",
    block(":root", { ...staticProps, ...themeProps(themes.light) }),
    emitRecipeCss(":root"),
    "@media (pointer: fine) { :root { --target-min: 32px; } }",
    [
      "@media (prefers-color-scheme: dark) {",
      block(":root:not([data-theme])", themeProps(themes.dark))
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      "}",
    ].join("\n"),
  ];
  for (const name of Object.keys(themes) as ThemeName[]) {
    blocks.push(block(`[data-theme='${name}']`, themeProps(themes[name])));
  }
  blocks.push(densityBlocks(), REDUCED_MOTION);
  return `${blocks.join("\n\n")}\n`;
}
