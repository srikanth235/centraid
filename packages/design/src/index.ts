// Centraid — shared design system.
// Single source of truth for colors, typography, spacing, density,
// tile-finishes, icons, and built-in app metadata.
//
// Three lowerings of the one contract:
//   - Desktop/web shell — CSS vars via `toCss()`, injected at boot.
//   - Blueprint apps    — CSS vars via `toBlueprintCss()`, served to the
//                         sandboxed app surface.
//   - Expo mobile       — imports the typed values (`type`, `spacing`,
//                         `radii`, …) and lowers `toBlueprintCss()` ahead of
//                         time into `apps/mobile/src/kit/theme/
//                         tokens.generated.ts` (see that app's
//                         `scripts/generate-theme.ts`). It does not consume
//                         `toCss()` or the `themes` presets.
//
// Canonical design document: DESIGN.md (repo root).

export { palette } from "./palette";
export type { Palette, ColorKey, ColorHex } from "./palette";

export { themes, lightTheme, darkTheme, THEME_PRESETS } from "./themes";
export { ACCENT_DEEP, ACCENT_LIGHT, ACCENT_TEXT_LIGHT } from "./themes";

// Accent ramp derivation — keeps a picked accent's tint/shade/text variants on
// the accent's own hue instead of hand-picking them. See src/accent.ts.
export { accentRamp } from "./color";
export type { AccentRamp } from "./color";

// Contrast/oklab maths lives behind the `@centraid/design/oklab` subpath, NOT
// this barrel: it is measurement machinery, not a token, and `packages/client`
// re-exports this index — pulling one more module through it trips the
// 100-module barrel ceiling. See react/shell/routes/builder/
// BuilderCode.tokens.test.ts for the consumer.
export type { Theme, ThemeName, ThemePreset } from "./themes";

// Brand teal — theme-independent identity color shared by the logo /
// app-icon SVGs and emitted as `--brand`. Also aliased as `brand`.
export { BRAND, BRAND as brand } from "./themes";

export { spacing } from "./density";
export type { DensityScale } from "./density";

export { radii } from "./radii";
export type { RadiusKey } from "./radii";

export {
  fonts,
  fontStacks,
  marketingType,
  type,
  typeShorthand,
} from "./typography";
export type {
  FontFamily,
  MarketingTypeKey,
  MarketingTypeStyle,
  TypeKey,
  TypeStyle,
} from "./typography";

export { library } from "./library";
export type { LibraryTokenKey } from "./library";

export { tileFinish, TILE_VARIANTS } from "./tile";
export type { TileVariant, TileFinish } from "./tile";

export { toCss } from "./css";
export { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract";

// Blueprint-app ("field notebook") token layer — a separate design
// language for the sandboxed blueprint apps, not a variant of `toCss()`'s
// desktop theme. See src/blueprint.ts for the rationale.
export { toBlueprintCss } from "./blueprint";

export { icons } from "./icons";
export type { IconName, IconPath } from "./icons";

export { apps } from "./apps";
export type { AppMeta, AppMetaResolved } from "./apps";
