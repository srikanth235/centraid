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
export { IDENTITY_COLORS, identityColor, identityInitials } from "./identity";
export type { IdentityPaletteKey } from "./identity";
export { formatBytes, formatRelativeTime } from "./format";

export { themes, lightTheme, darkTheme, THEME_PRESETS } from "./themes";
export {
  ACCENT_PALETTE,
  ACCENT_DEEP,
  ACCENT_LIGHT,
  ACCENT_TEXT_LIGHT,
} from "./themes";
export type { AccentKey } from "./themes";

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
// app-icon SVGs and emitted as `--accent`. Also aliased as `brand`.
export { BRAND, BRAND as brand } from "./themes";

export { spacing } from "./density";
export type { DensityScale } from "./density";

export { radii } from "./radii";
export type { RadiusKey } from "./radii";

export {
  fonts,
  fontStacks,
  blueprintType,
  blueprintTypeShorthand,
  nativeTypeStyle,
  type,
  typeShorthand,
  typeForProfile,
  typeSizeRungs,
} from "./typography";
export type {
  BlueprintTypeStyle,
  FontFamily,
  NativeDelta,
  TypeKey,
  TypeStyle,
} from "./typography";

export { library } from "./library";
export type { LibraryTokenKey } from "./library";

export { tileFinish, TILE_VARIANTS } from "./tile";
export type { TileVariant, TileFinish } from "./tile";

export { toCss } from "./css";
export { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract";
export {
  ADAPTERS,
  PROFILE_SURFACES,
  ROLE_REGISTRY,
  assertTotalProfileValues,
  contractForProfile,
  profileForSurface,
  rolesForProfile,
} from "./roles";
export type {
  Profile,
  ProfileValue,
  RoleCategory,
  RoleDef,
  RoleValueKind,
  Surface,
} from "./roles";

export {
  BUTTON_VARIANTS,
  RECIPES,
  RECIPE_NAMES,
  getRecipe,
} from "./recipes/index";
export type {
  ButtonVariant,
  Recipe,
  RecipeName,
  RecipeState,
} from "./recipes/index";
export { emitRecipeCss } from "./recipes/css";
export { NATIVE_RECIPES, nativeButtonStyle } from "./recipes/native";
export type { NativeButtonStyle, NativeRecipeLowering } from "./recipes/native";

// Blueprint-app ("field notebook") token layer — a separate design
// language for the sandboxed blueprint apps, not a variant of `toCss()`'s
// desktop theme. See src/blueprint.ts for the rationale.
export { toBlueprintCss } from "./blueprint";
export { toNativeTheme } from "./native";
export type {
  NativeColors,
  NativeScheme,
  NativeTheme,
  NativeTypeStyle,
} from "./native";

export { iconPathMarkup, icons } from "./icons";
export { ICON_CONCEPTS, iconForConcept, iconSvg, isIconName } from "./icons";
export type { IconConcept, IconName, IconPath } from "./icons";

export { apps } from "./apps";
export type { AppMeta, AppMetaResolved } from "./apps";
