export const radii = {
  xs: 0,
  sm: 4,
  md: 7,
  lg: 12,
  pill: 999,
} as const;

export type RadiusKey = keyof typeof radii;

export const ICON_CHIP_RADIUS_RATIO = 0.26;

export function iconChipRadius(size: number): number {
  return Math.round(size * ICON_CHIP_RADIUS_RATIO * 100) / 100;
}
