export const SKELETON_ROWS = 6;

export const SKELETON_BONE_START = 66;

export const SKELETON_BONE_STEP = 6;

export const SKELETON_BONE_FLOOR = 24;

export const SKELETON_PULSE_MS = 1600;

export const SKELETON_PULSE_HIGH = 0.55;

export const SKELETON_PULSE_LOW = 0.28;

export const SKELETON_STAGGER_MS = 90;

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
