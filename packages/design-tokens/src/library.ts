// Centraid — shared library-tile tokens.
// Home and Discover render the same tile on two pages, so every value they
// share lives here ONCE (emitted by `toCss()` as `--lib-*`). Tweak a tile
// dimension/tone in one place and both pages move together; nothing drifts.
//
// `tile-h` is sized to fit the richest tile (a Home automation: glyph +
// blurb + status/trigger meta strip + foot); sparser tiles pin their foot
// to the bottom and leave the slack above.

export const library = {
  // Rows-layout kind-badge column width — keeps APP/AUTOMATION aligned
  // across Home and Discover; both rows footers reference it.
  'row-badge-w': '116px',
  // Library shelf envelope — Home and Discover share the same max width +
  // horizontal padding so their grids resolve identically.
  'shelf-max': '1560px',
  'shelf-pad-x': '56px',
  'tile-bg': 'color-mix(in srgb, var(--ink) 2.5%, transparent)',
  'tile-bg-hover': 'color-mix(in srgb, var(--ink) 5%, transparent)',
  'tile-gap': '11px',
  'tile-h': '248px',
  'tile-icon': '44px',
  'tile-icon-radius': '12px',
  'tile-pad': '15px 16px',
  'tile-radius': '12px',
} as const;

export type LibraryTokenKey = keyof typeof library;
