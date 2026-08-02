// Hard-edged radii — Centraid is an instrument, not a pillow.
// Components live between 6–14px; sheets/modals soften past that.
// Anything bigger than `xl` is composed inline (`var(--r-xl)` + a pill on FABs).

export const radii = {
  xs: 2,
  sm: 4,
  md: 6,
  lg: 10,
  xl: 14,
  pill: 999,
} as const;

export type RadiusKey = keyof typeof radii;
