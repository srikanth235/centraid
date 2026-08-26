import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ORRERY } from "./atlasOrreryGeometry.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const reducedMotionQuery = (): MediaQueryList | null =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(REDUCED_MOTION_QUERY);

const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const mq = reducedMotionQuery();
  if (!mq) return () => {};
  mq.addEventListener?.("change", onChange);
  return () => mq.removeEventListener?.("change", onChange);
};

const readReducedMotion = (): boolean => reducedMotionQuery()?.matches ?? false;

const serverReducedMotion = (): boolean => false;

const RECENTER_MS = 640;

const canAnimateRecenter = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  typeof requestAnimationFrame === "function";

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

function driveRecenter(
  onProgress: (p: number) => void,
  onSettled: () => void
): () => void {
  const t0 = performance.now();
  let raf = requestAnimationFrame(function step(now: number) {
    const t = Math.min(1, (now - t0) / RECENTER_MS);
    onProgress(easeInOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(step);
    else onSettled();
  });
  return () => cancelAnimationFrame(raf);
}

// Radius-only re-centre (#519). Bearings never animate (anti-hairball) —
// only each kind's radial distance eases so pack identity stays a compass.

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    serverReducedMotion
  );
}

export function useRecenterAnimation(
  center: string,
  targetRadius: Map<string, number>,
  reduced: boolean
): (physical: string) => number {
  const startRadiusRef = useRef<Map<string, number>>(new Map());
  const [progress, setProgress] = useState(1);

  // Centre change during render so the ease starts on the first new-centre frame.
  const [animCenter, setAnimCenter] = useState(center);
  if (animCenter !== center) {
    setAnimCenter(center);
    setProgress(canAnimateRecenter() && !reduced ? 0 : 1);
  }

  useEffect(() => {
    if (startRadiusRef.current.size === 0 || reduced || !canAnimateRecenter()) {
      startRadiusRef.current = new Map(targetRadius);
      return;
    }
    return driveRecenter(setProgress, () => {
      startRadiusRef.current = new Map(targetRadius);
    });
    // Only a centre change re-runs the ease; `targetRadius` is a value, not a trigger.
  }, [animCenter, targetRadius, reduced]);

  return useCallback(
    (physical: string): number => {
      const target = targetRadius.get(physical) ?? ORRERY.ringUnreached;
      if (progress >= 1) return target;
      const start = startRadiusRef.current.get(physical) ?? target;
      return start + (target - start) * progress;
    },
    [targetRadius, progress]
  );
}
