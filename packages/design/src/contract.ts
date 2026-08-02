// The one public CSS-token vocabulary. Emitters may choose values appropriate
// to their surface, but cannot invent a second spelling for a semantic role.

import { spacing } from "./density";
import { library } from "./library";
import { palette } from "./palette";
import { radii } from "./radii";
import {
  blueprintType,
  fontStacks,
  marketingType,
  type,
  typeKeyToKebab as kebab,
  typeSizeRungs,
} from "./typography";

const shellStatic = [
  ...Object.keys(palette).map((key) => `--c-${key}`),
  ...Object.keys(radii).map((key) => `--r-${key}`),
  ...Object.keys(spacing).map((key) => `--sp-${key}`),
  "--ease",
  "--brand",
  "--on-accent",
  ...Object.keys(fontStacks).map((key) => `--font-${key}`),
  ...Object.keys({ ...type, ...marketingType }).map(
    (key) => `--t-${kebab(key)}`
  ),
  // Derived, never hand-listed: the rung set collapses keys that share a size
  // (body/bodyStrong), so a literal list here would drift the moment the scale
  // gains or merges a size.
  ...Object.keys(typeSizeRungs({ ...type, ...marketingType })),
  ...Object.keys(library).map((key) => `--lib-${key}`),
] as const;

const surface = [
  // The palette hues as `color:` — solved per theme, unlike the `--c-*` fills
  // above, which are theme-independent. See `paletteText` in color.ts.
  ...Object.keys(palette).map((key) => `--c-${key}-text`),
  "--accent",
  "--accent-deep",
  "--accent-light",
  "--accent-midnight",
  "--accent-text",
  "--danger",
  "--success",
  "--warning",
  "--bezel",
  "--bezel-inner",
  "--bg",
  "--bg-app",
  "--bg-elev",
  "--bg-sunken",
  "--bg-wall",
  "--device-wall",
  "--text",
  "--text-soft",
  "--text-faint",
  "--text-ghost",
  "--text-inv",
  "--line",
  "--line-strong",
  "--scrim",
  "--shadow-lg",
  "--shadow-md",
  "--shadow-sm",
  "--sidebar-bg",
  "--sidebar-blur",
  "--sidebar-divider",
] as const;

export const SHELL_TOKEN_CONTRACT = [...shellStatic, ...surface].sort();

// Blueprint apps share the semantic surface names and add their portable
// identity/type primitives. These are all emitted in the default root block.
export const BLUEPRINT_TOKEN_CONTRACT = [
  "--app-hue",
  "--font-sans",
  "--font-serif",
  "--font-title",
  "--mono",
  ...Object.keys(palette).map((key) => `--c-${key}`),
  ...Object.keys(palette).map((key) => `--c-${key}-text`),
  "--accent",
  "--on-accent",
  "--_accent",
  "--accent-soft",
  "--accent-deep",
  "--accent-text",
  "--sel",
  "--selb",
  "--text",
  "--text-soft",
  "--text-faint",
  "--text-inv",
  "--bg",
  "--bg-elev",
  "--bg-sunken",
  "--line",
  "--line-strong",
  "--scrim",
  "--danger",
  "--warning",
  "--success",
  "--r-card",
  "--r-md",
  "--r-sm",
  "--r-pill",
  "--radius",
  "--radius-sm",
  ...Object.keys(spacing).map((key) => `--sp-${key}`),
  "--ease",
  "--focus-ring",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--tracking-body",
  "--tracking-h",
  "--tracking-eyebrow",
  // The blueprint type scale and its size rungs — both derived from
  // `blueprintType`, for the same reason the shell half above is.
  ...Object.keys(blueprintType).map((key) => `--t-${kebab(key)}`),
  ...Object.keys(typeSizeRungs(blueprintType)),
].sort();
