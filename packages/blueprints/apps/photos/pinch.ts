// Pinch-to-rung on the compact surface (v4 handoff §4.2, §15, CHANGELOG D).
//
// Tile size is ONE member preference with four rungs, and on the phone pinch
// does the same thing the stepper does — all four rungs, because dropping
// rungs on one surface would make a member preference surface-specific.
//
// THE RULE THIS EXISTS UNDER: every gesture has a pointer equivalent, so
// nothing is reachable by gesture alone. This module adds no capability; the
// stepper in the toolbar row is the pointer path and remains the only way in
// on a surface with a mouse.
import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** How far apart two fingers must travel before the rung steps. Deliberately
 *  coarse: four rungs over the whole pinch range, not a continuous zoom. */
const IN = 1.35;
const OUT = 0.74;

export interface PinchHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Pointer handlers that step the tile-size rung on a two-finger pinch.
 * Returns `null` when the caller passes no `onStep` — a surface with no pinch
 * then spreads nothing rather than binding four dead listeners to every scroll
 * of the grid.
 */
export function usePinchRung(
  onStep: ((delta: number) => void) | undefined
): PinchHandlers | null {
  const points = useRef(new Map<number, { x: number; y: number }>());
  const baseline = useRef<number | null>(null);

  const spread = useCallback((): number | null => {
    const two = [...points.current.values()];
    if (two.length !== 2) return null;
    const [a, b] = two as [{ x: number; y: number }, { x: number; y: number }];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }, []);

  const down = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      baseline.current = spread();
    },
    [spread]
  );

  const move = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!points.current.has(e.pointerId)) return;
      points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = spread();
      const base = baseline.current;
      if (now === null || base === null || base <= 0) return;
      const ratio = now / base;
      if (ratio >= IN) {
        onStep?.(1);
        baseline.current = now;
      } else if (ratio <= OUT) {
        onStep?.(-1);
        baseline.current = now;
      }
    },
    [onStep, spread]
  );

  const up = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      points.current.delete(e.pointerId);
      baseline.current = spread();
    },
    [spread]
  );

  if (!onStep) return null;
  return {
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: up,
  };
}
