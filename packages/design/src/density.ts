export interface DensityScale {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
}

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
} as const satisfies DensityScale;

export const subBase = {
  gutter: 2,
  hair: 1,
} as const;

export const metrics = {
  control: 34,
  controlTouch: 44,
  row: 44,
  segmented: 28,
  keyCol: 150,
  keyColTouch: 110,
  stem: 240,
  appRail: 232,
  appRailRow: 30,
  bandCapsule: 52,
} as const;

export type MetricKey = keyof typeof metrics;

export const pageMargin = {
  desktop: 32,
  mobile: 18,
} as const;

export const DENSITY_TIERS = {
  comfortable: { pad: spacing[4], row: metrics.row },
  compact: { pad: spacing[3], row: 38 },
  dense: { pad: spacing[2], row: metrics.control },
} as const;

export type DensityTier = keyof typeof DENSITY_TIERS;

export const DENSITY_TIER_NAMES = [
  "comfortable",
  "compact",
  "dense",
] as const satisfies readonly DensityTier[];

export const DEFAULT_DENSITY_TIER: DensityTier = "comfortable";
