// Centraid — shared design system.
// Single source of truth for colors, typography, spacing, density,
// tile-finishes, icons, and built-in app metadata.
//
// Three direct lowerings of the one contract:
//   - Desktop/web shell — CSS vars via `toCss()`, injected at boot.
//   - Blueprint apps    — CSS vars via `toBlueprintCss()`, served to the
//                         sandboxed app surface.
//   - Expo mobile       — concrete typed values via `toNativeTheme()`; its
//                         adapter only maps Expo font names and RN tracking.
//
// There is no copied theme or platform-specific token registry. A value is
// either canonical here, or it is a renderer concern at one adapter boundary.
//
// Canonical design document: DESIGN.md (repo root).

export {
  APP_HUES,
  clampIdentityHue,
  IDENTITY_CHROMA,
  palette,
  paletteDark,
  paletteFor,
} from "./palette";
export type { Palette, ColorKey, ColorHex } from "./palette";
export {
  IDENTITY_COLORS,
  IDENTITY_HUE_KEYS,
  identityColor,
  identityFill,
  identityHueKey,
  identityInitials,
  identityInk,
} from "./identity";
export type { IdentityPaletteKey } from "./identity";
export { formatBytes, formatRelativeTime, localDayKey } from "./format";

export { themes, lightTheme, darkTheme, THEME_PRESETS } from "./themes";
export {
  ACCENT_HOVER,
  ACCENT_HOVER_DARK,
  ACCENT_LIGHT,
  ACCENT_LIGHT_DARK,
  BRAND,
  BRAND_DARK,
  DUR_ENTRY,
  DUR_STATE,
  EASE,
  EASE_ENTRY,
  LINK,
  LINK_DARK,
  NET,
  NET_DARK,
  ON_STAGE,
  RING,
  RING_DARK,
  STAGE,
  STAGE_LINE,
} from "./themes";

// Contrast/oklab maths lives behind the `@centraid/design/oklab` subpath, NOT
// this barrel: it is measurement machinery, not a token, and `packages/client`
// re-exports this index — pulling one more module through it trips the
// 100-module barrel ceiling. See react/shell/routes/builder/
// BuilderCode.tokens.test.ts for the consumer.
export type { Theme, ThemeName, ThemePreset } from "./themes";

// The product mark, which is INK: the shell spends no hue, so every colour on
// screen provably belongs to an app. `BRAND_DARK` is the same mark on the
// dark ramp; both are exported from the themes barrel above.

export {
  DEFAULT_DENSITY_TIER,
  DENSITY_TIER_NAMES,
  DENSITY_TIERS,
  metrics,
  spacing,
} from "./density";
export type { DensityScale, DensityTier, MetricKey } from "./density";

export { ICON_CHIP_RADIUS_RATIO, iconChipRadius, radii } from "./radii";
export type { RadiusKey } from "./radii";

export { borders } from "./borders";
export type { BorderKey } from "./borders";

export {
  fonts,
  fontStacks,
  NATIVE_DELTA_BY_FAMILY,
  NATIVE_DELTA_OVERRIDES,
  TYPE_PROFILE_SUPPORT,
  blueprintType,
  blueprintTypeForSurface,
  blueprintTypeShorthand,
  nativeTypeStyle,
  type,
  typeShorthand,
  typeForProfile,
  typeForSurface,
  typeModifiers,
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

export {
  tileFinish,
  TILE_VARIANTS,
  ICON_CHIP_TINT,
  APP_MARK_SMALL_STROKE,
  APP_MARK_STROKE,
  APP_MARK_VIEWBOX,
  iconChipFinish,
} from "./tile";
export type { TileVariant, TileFinish, IconChipFinish } from "./tile";

export { toCss } from "./css";
export { BLUEPRINT_TOKEN_CONTRACT, SHELL_TOKEN_CONTRACT } from "./contract";
export {
  ADAPTERS,
  DARK_THEME_ROLE_VALUES,
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
export { nativeButtonStyle } from "./recipes/native";
export type { NativeButtonStyle } from "./recipes/native";

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

export { DESTINATION_MARKS } from "./destinations";
export type { DestinationConcept } from "./destinations";
export { iconPathMarkup, icons } from "./icons";
export { ICON_CONCEPTS, iconForConcept, iconSvg, isIconName } from "./icons";
export type { IconConcept, IconName, IconPath } from "./icons";

export { apps } from "./apps";
export type { AppMeta, AppMetaResolved } from "./apps";
