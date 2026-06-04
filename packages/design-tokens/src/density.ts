// Centraid — density-aware spacing scale.
// Three tiers: compact / regular / comfy. Each maps tokens 1..7 to pixel
// values. `regular` is the default — everywhere else in the app, plain
// `spacing` is exported as an alias for `densities.regular`.

export interface DensityScale {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
  7: number;
}

export const densities = {
  comfy: { 1: 5, 2: 10, 3: 14, 4: 20, 5: 30, 6: 40, 7: 56 },
  compact: { 1: 3, 2: 6, 3: 9, 4: 12, 5: 18, 6: 24, 7: 36 },
  regular: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 },
} as const satisfies Record<string, DensityScale>;

export type DensityName = keyof typeof densities;

/** Default spacing scale = `densities.regular`. Imported app-wide. */
export const spacing = densities.regular;
