// The only lowering of shared design values into custom properties. Two axes
// no component may re-own: density (row height and padding, never control
// size) and reduced motion. No surface-tone axis — one page colour, `--bg`
// (docs/traps/design-tokens.md).

import {
  DENSITY_TIERS,
  metrics,
  pageMargin,
  spacing,
  subBase,
} from "./density";
import { library } from "./library";
import { paletteFor, paletteText } from "./palette";
import { radii } from "./radii";
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
  typeForSurface,
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
    // The OUTLINE's hover steps the other way.
    "--accent-hover": theme.accentInkHover,
    "--accent-light": theme.accentLight,
    "--accent-soft": `color-mix(in oklab, ${theme.accent} 8%, transparent)`,
    "--accent-text": theme.accentText,
    "--attention": theme.attention,
    "--app-mark-hue": "var(--c-slate)",
    "--app-mark-ink": "var(--app-identity-text)",
    "--app-mark-size": "30px",
    "--app-mark-tint": theme.kind === "dark" ? "20%" : "13%",
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
    "--net-hover": theme.netHover,
    // A concrete `rgba()`, never a `color-mix()`: alpha differs per theme.
    "--net-wash": theme.netWash,
    "--on-accent": theme.textInv,
    "--seam": theme.seam,
    // The SAME literal in both themes.
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

/** No tier may scale control size: below 34px it stops being hittable. */
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

/** Duration to zero and nothing else — movement, not layout. */
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
  const touchType = typeForSurface(true);
  for (const [key, value] of Object.entries(radii))
    staticProps[`--r-${key}`] = `${value}px`;
  for (const [key, value] of Object.entries(spacing))
    staticProps[`--sp-${key}`] = `${value}px`;
  // These two names are the whole allowlist for reaching under the base.
  for (const [key, value] of Object.entries(subBase))
    staticProps[`--sp-${key}`] = `${value}px`;

  staticProps["--ease"] = EASE;
  staticProps["--ease-entry"] = EASE_ENTRY;
  staticProps["--target-min"] = `${metrics.controlTouch}px`;
  staticProps["--o-disabled"] = "0.45";
  staticProps["--dur-1"] = "140ms";
  staticProps["--dur-2"] = "280ms";
  // From `metrics`, never re-typed; `roles.ts` emits the same to native.
  staticProps["--h-control"] = `${metrics.control}px`;
  staticProps["--h-row"] = `${metrics.row}px`;
  staticProps["--h-segmented"] = `${metrics.segmented}px`;
  staticProps["--w-stem"] = `${metrics.stem}px`;
  staticProps["--w-key-col"] = `${metrics.keyColTouch}px`;
  // THE PAGE MARGIN, so no blueprint invents one. The compact rung is NOT a
  // media query: a narrow pane re-declares it and its subtree follows (#505).
  staticProps["--page-margin"] = `${pageMargin.mobile}px`;
  staticProps["--density-row"] = `${DENSITY_TIERS.comfortable.row}px`;
  staticProps["--density-pad"] = `${DENSITY_TIERS.comfortable.pad}px`;
  for (const [key, value] of Object.entries(fontStacks))
    staticProps[`--font-${key}`] = value;
  for (const [key, value] of Object.entries(touchType)) {
    staticProps[`--t-${typeKeyToKebab(key)}`] = typeShorthand(value);
  }
  Object.assign(
    staticProps,
    typeSizeRungs(remSizeScale(touchType)),
    typeModifiers(type)
  );

  const pointerProps: Record<string, string> = {
    "--page-margin": `${pageMargin.desktop}px`,
    "--target-min": `${metrics.control}px`,
    "--w-key-col": `${metrics.keyCol}px`,
  };
  for (const [key, value] of Object.entries(type)) {
    pointerProps[`--t-${typeKeyToKebab(key)}`] = typeShorthand(value);
  }
  Object.assign(pointerProps, typeSizeRungs(remSizeScale(type)));

  // `--tile-` is deliberately not per-surface.
  for (const [key, value] of Object.entries(library)) {
    const suffix = key.startsWith("tile-") ? key.slice("tile-".length) : key;
    staticProps[`--tile-${suffix}`] = value;
  }

  // The un-stamped first paint, so BOTH themes must be reachable here. Never
  // fix a light flash by hardcoding `data-theme` in index.html: a stamped
  // attribute always wins, and "follow the system" becomes unreachable.
  const blocks = [
    "/* Generated by @centraid/design — do not edit by hand. */",
    block(":root", { ...staticProps, ...themeProps(themes.light) }),
    // 44px on touch, `metrics.control` under a pointer; never a literal 32.
    [
      "@media (pointer: fine) {",
      block(":root", pointerProps)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      "}",
    ].join("\n"),
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
