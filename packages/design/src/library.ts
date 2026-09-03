export const library = {
  "row-badge-w": "116px",
  "shelf-max": "1560px",
  "shelf-pad-x": "56px",
  "tile-bg": "color-mix(in srgb, var(--text) 2.5%, transparent)",
  "tile-bg-hover": "color-mix(in srgb, var(--text) 5%, transparent)",
  "tile-gap": "11px",
  "tile-h": "248px",
  "tile-icon": "44px",
  "tile-icon-radius": "11.44px",
  "tile-pad": "15px 16px",
  "tile-radius": "12px",
} as const;

export type LibraryTokenKey = keyof typeof library;
