// Hard-edged radii — Centraid is an instrument, not a pillow.
// Components live between 6–14px; sheets/modals soften past that.
// Anything bigger than `xl` is composed inline (`var(--r-xl)` + a pill on FABs).

export const radii = { lg: 10, md: 6, sm: 4, xl: 14, xs: 2 } as const;

export type RadiusKey = keyof typeof radii;
