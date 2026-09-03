import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const IN = 1.35;
const OUT = 0.74;

export interface PinchHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

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
