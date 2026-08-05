// Tile size: one member preference with four rungs (Photos v4 handoff §4.2).
//
// The preference is stored as ONE index (0-3), not a per-surface pixel value —
// each surface maps that index to its own target row height. ALL FOUR rungs
// are kept on the phone: dropping rungs there would make a member preference
// surface-specific, which is the one thing §4.2 and CHANGELOG §D both refuse.
//
// The numbers are the handoff's table, and they are deliberately identical to
// `packages/blueprints/apps/photos/layout.ts` — mobile has its own runtime, so
// the table is duplicated rather than imported across the boundary, but a
// divergence in the numbers would be a bug in both.

export const RUNG_LABELS = ["XS", "S", "M", "L"] as const;
export type Rung = 0 | 1 | 2 | 3;

export interface RungTargets {
  /** Target row height (px) on desktop/Electron and the installable PWA. */
  desktop: number;
  /** Target row height (px) on a phone-width surface. */
  phone: number;
}

export const RUNGS: readonly RungTargets[] = [
  { desktop: 92, phone: 64 }, // XS
  { desktop: 128, phone: 88 }, // S
  { desktop: 176, phone: 120 }, // M — default
  { desktop: 248, phone: 168 }, // L
];

export const DEFAULT_RUNG: Rung = 2; // M

/** Where the member's rung lives on this device. */
export const RUNG_KEY = "photos.tileSize";

export function clampRung(value: number): Rung {
  return Math.min(RUNGS.length - 1, Math.max(0, Math.round(value))) as Rung;
}

/** Resolves a stored rung index to this surface's target row height (px). */
export function rungHeight(rung: Rung, surface: "desktop" | "phone"): number {
  return RUNGS[rung]![surface];
}

/**
 * The stepper: one rung per press. `+1` is a LARGER tile (a longer row height),
 * so the stepper's "bigger" and the rung table's order agree.
 */
export function stepRung(rung: Rung, delta: number): Rung {
  return clampRung(rung + delta);
}

/**
 * Pinch, which "does the same thing as the stepper" (§4.2 / CHANGELOG §D).
 * Not a continuous zoom: a pinch resolves to a stepper press, so the gesture
 * and the pointer control cannot drift to different rungs — and every gesture
 * keeps its pointer equivalent, so nothing is reachable by gesture alone.
 *
 * Spreading apart (scale > 1) means "bigger tiles"; pinching in means smaller.
 * The dead band keeps an incidental two-finger scroll from changing a stored
 * member preference.
 */
export const PINCH_OUT_THRESHOLD = 1.15;
export const PINCH_IN_THRESHOLD = 0.86;

export function pinchRung(rung: Rung, scale: number): Rung {
  if (scale >= PINCH_OUT_THRESHOLD) return stepRung(rung, 1);
  if (scale <= PINCH_IN_THRESHOLD) return stepRung(rung, -1);
  return rung;
}
