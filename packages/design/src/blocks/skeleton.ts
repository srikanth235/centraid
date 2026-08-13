// The loading skeleton's shape and breath (#765, spec §10).
//
// Every number here is a claim, and it is the same claim on both renderers:
// six rows (enough that the shape reads as a list, few enough that it never
// outruns the fold), a bone that steps 6% narrower per row (so the block reads
// as prose of varying length rather than as a bar chart), and a 1.6s breath
// staggered 90ms down the list. A skeleton breathes; it never spins.
//
// The DOM lowering spells these as CSS (`react/styles/pageSkeleton.module.css`
// in `packages/client`, pinned to this module by its parity test) because a
// stylesheet cannot import; the native lowering reads them directly. Either
// way there is one source for the values.

/** How many rows a loading block draws. */
export const SKELETON_ROWS = 6;

/** The first bone's width, as a share of the row. */
export const SKELETON_BONE_START = 66;

/** How much narrower each following bone is. */
export const SKELETON_BONE_STEP = 6;

/** The narrowest a bone may get, whatever the row count. The step reaches the
 *  sixth row at 36; the floor only matters to a caller asking for more rows
 *  than the reference specifies, and it exists so those get narrow bones
 *  rather than negative ones. */
export const SKELETON_BONE_FLOOR = 24;

/** The breath: opacity .55 → .28 → .55, over this long. */
export const SKELETON_PULSE_MS = 1600;

/** The resting opacity — and the value a collapsed animation must land on, so
 *  that reduced motion renders a still, fully legible bone. */
export const SKELETON_PULSE_HIGH = 0.55;

/** The bottom of the breath. */
export const SKELETON_PULSE_LOW = 0.28;

/** Each row starts its breath this much after the one above it. */
export const SKELETON_STAGGER_MS = 90;

/**
 * Bone widths, as shares of the row: `66, 60, 54, 48, 42, 36` for the standard
 * six. Numbers, not units — a `%` string and a CSS custom property are two
 * renderings of the one sequence.
 */
export function boneWidths(rows: number): readonly number[] {
  return Array.from({ length: Math.max(0, rows) }, (_unused, index) =>
    Math.max(
      SKELETON_BONE_FLOOR,
      SKELETON_BONE_START - index * SKELETON_BONE_STEP
    )
  );
}

/** When row `index` starts its breath. */
export function boneDelay(index: number): number {
  return index * SKELETON_STAGGER_MS;
}
