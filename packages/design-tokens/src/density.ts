// Centraid's fixed spacing scale. Mobile consumes these typed values; the
// browser now uses explicit spacing at the few former density call sites.

export interface DensityScale {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
  7: number;
}

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
} as const satisfies DensityScale;
