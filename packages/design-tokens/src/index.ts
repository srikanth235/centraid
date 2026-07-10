// Centraid — shared design system.
// Single source of truth for colors, typography, spacing, density,
// tile-finishes, icons, and built-in app metadata. Both surfaces
// (Electron desktop, Expo mobile) consume this package; CSS for the
// desktop is generated from these typed values via `toCss()`.

export { palette } from './palette';
export type { Palette, ColorKey, ColorHex } from './palette';

export { themes, lightTheme, darkTheme, THEME_PRESETS } from './themes';
export type { Theme, ThemeName, ThemePreset } from './themes';

// Brand teal — theme-independent identity color shared by the logo /
// app-icon SVGs and emitted as `--brand`. Also aliased as `brand`.
export { BRAND, BRAND as brand } from './themes';

export { densities, spacing } from './density';
export type { DensityScale, DensityName } from './density';

export { radii } from './radii';
export type { RadiusKey } from './radii';

export { fonts, fontStacks, marketingType, type, typeShorthand } from './typography';
export type {
  FontFamily,
  MarketingTypeKey,
  MarketingTypeStyle,
  TypeKey,
  TypeStyle,
} from './typography';

export { library } from './library';
export type { LibraryTokenKey } from './library';

export { tileFinish, TILE_VARIANTS } from './tile';
export type { TileVariant, TileFinish } from './tile';

export { toCss } from './css';

export { icons } from './icons';
export type { IconName, IconPath } from './icons';

export { apps } from './apps';
export type { AppMeta, AppMetaResolved } from './apps';

// ---- Backwards-compat aliases ----
// `colors` was the original (light-only) export consumed by mobile and
// the desktop preload. Kept as an alias for `themes.light` so existing
// call sites don't have to change in this migration. New code should
// prefer `themes.light` / `themes.dark`.
export { lightTheme as colors, darkTheme as colorsDark } from './themes';
