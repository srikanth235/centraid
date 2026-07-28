import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ORRERY } from "./atlasOrreryGeometry.js";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** `null` in any host without `matchMedia` (jsdom, SSR) — there is no
 *  preference to read, so motion is never suppressed. */
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

/** jsdom (and SSR) have neither `matchMedia` nor `requestAnimationFrame` — there
 *  an ease would only schedule frames that never composite, so we snap. */
const canAnimateRecenter = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  typeof requestAnimationFrame === "function";

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/**
 * Drive one re-centre ease, reporting 0→1 progress per frame and calling
 * `onSettled` once the last frame lands. Returns the canceller. Module scope,
 * because the rAF loop names itself and a self-referential function declared
 * inside a hook is not a value the compiler can reason about.
 */
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

// The orrery's re-centre motion (issue #519), lifted out of AtlasRelationsTab.
// Two concerns: reading the user's reduced-motion preference, and the
// radius-only re-centre animation. Bearings never animate (the anti-hairball
// invariant) — only each kind's radial distance eases to its new ring when the
// centre changes, so pack identity stays a fixed compass direction throughout.

export function usePrefersReducedMotion(): boolean {
  // Subscribed, not synced-through-an-effect: the very first paint already
  // knows the preference, so a reduced-motion user never sees one animated
  // frame before the effect catches up.
  return useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    serverReducedMotion
  );
}

/**
 * The radius-only re-centre animation. Given the current centre and each kind's
 * target radius (computed by the caller from hop distance), returns a `radiusOf`
 * reader that eases from the previous rings to the new ones on a centre change.
 * Snaps (no animation) on first paint, under reduced-motion, and in any host
 * without `matchMedia`/`requestAnimationFrame` (jsdom) — there, animating would
 * only schedule frames that never composite.
 */
export function useRecenterAnimation(
  center: string,
  targetRadius: Map<string, number>,
  reduced: boolean
): (physical: string) => number {
  const startRadiusRef = useRef<Map<string, number>>(new Map());
  const [progress, setProgress] = useState(1);

  // The centre the current `progress` belongs to. A centre change is picked up
  // during render (the React "adjust state when a prop changes" pattern) rather
  // than in the effect, so the ease starts from 0 on the very first frame the
  // new centre paints instead of one cascading render later.
  const [animCenter, setAnimCenter] = useState(center);
  if (animCenter !== center) {
    setAnimCenter(center);
    setProgress(canAnimateRecenter() && !reduced ? 0 : 1);
  }

  useEffect(() => {
    // Snap (no animation) on first paint, under reduced-motion, and in any host
    // without `matchMedia`/`requestAnimationFrame` (jsdom) — there, animating
    // would only schedule frames that never composite.
    if (startRadiusRef.current.size === 0 || reduced || !canAnimateRecenter()) {
      startRadiusRef.current = new Map(targetRadius);
      return;
    }
    return driveRecenter(setProgress, () => {
      startRadiusRef.current = new Map(targetRadius);
    });
    // Only a centre change re-runs the ease; `targetRadius` is read for its
    // value at that moment, never as a trigger.
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
