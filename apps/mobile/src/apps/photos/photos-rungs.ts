// ONE stored rung index (0-3), mapped per surface; numbers duplicate
// blueprints/apps/photos/layout.ts on purpose.

export const RUNG_LABELS = ["XS", "S", "M", "L"] as const;
export type Rung = 0 | 1 | 2 | 3;

export interface RungTargets {
  desktop: number;
  phone: number;
}

export const RUNGS: readonly RungTargets[] = [
  { desktop: 92, phone: 64 },
  { desktop: 128, phone: 88 },
  { desktop: 176, phone: 120 },
  { desktop: 248, phone: 168 },
];

export const DEFAULT_RUNG: Rung = 2;

export const RUNG_KEY = "photos.tileSize";

export function clampRung(value: number): Rung {
  return Math.min(RUNGS.length - 1, Math.max(0, Math.round(value))) as Rung;
}

export function rungHeight(rung: Rung, surface: "desktop" | "phone"): number {
  return RUNGS[rung]![surface];
}

// +1 is a LARGER tile (stepper and table order agree).
export function stepRung(rung: Rung, delta: number): Rung {
  return clampRung(rung + delta);
}

export const PINCH_OUT_THRESHOLD = 1.15;
export const PINCH_IN_THRESHOLD = 0.86;

export function pinchRung(rung: Rung, scale: number): Rung {
  if (scale >= PINCH_OUT_THRESHOLD) return stepRung(rung, 1);
  if (scale <= PINCH_IN_THRESHOLD) return stepRung(rung, -1);
  return rung;
}
