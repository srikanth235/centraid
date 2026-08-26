// Skeleton shape and breath (#765, §10). One value source for both renderers:
// the DOM lowering spells these as CSS (`react/styles/pageSkeleton.module.css`
// in `packages/client`, pinned by its parity test); native reads them directly.
// A skeleton breathes; it never spins.

export const SKELETON_ROWS = 6;

export const SKELETON_BONE_START = 66;

export const SKELETON_BONE_STEP = 6;

/** Narrowest bone whatever the row count — extra-row callers get narrow bones, not negative ones. */
export const SKELETON_BONE_FLOOR = 24;

export const SKELETON_PULSE_MS = 1600;

/** Resting opacity AND the landing value a collapsed animation must reach, so reduced motion renders a legible still bone. */
export const SKELETON_PULSE_HIGH = 0.55;

export const SKELETON_PULSE_LOW = 0.28;

export const SKELETON_STAGGER_MS = 90;

/** Bone widths as shares of the row — plain numbers; a `%` string and a CSS custom property are two renderings of one sequence. */
export function boneWidths(rows: number): readonly number[] {
  return Array.from({ length: Math.max(0, rows) }, (_unused, index) =>
    Math.max(
      SKELETON_BONE_FLOOR,
      SKELETON_BONE_START - index * SKELETON_BONE_STEP
    )
  );
}

export function boneDelay(index: number): number {
  return index * SKELETON_STAGGER_MS;
}
