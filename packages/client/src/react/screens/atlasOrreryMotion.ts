import { useCallback, useEffect, useRef, useState } from 'react';
import { ORRERY } from './atlasOrreryGeometry.js';

// The orrery's re-centre motion (issue #519), lifted out of AtlasRelationsTab.
// Two concerns: reading the user's reduced-motion preference, and the
// radius-only re-centre animation. Bearings never animate (the anti-hairball
// invariant) — only each kind's radial distance eases to its new ring when the
// centre changes, so pack identity stays a fixed compass direction throughout.

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
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
  reduced: boolean,
): (physical: string) => number {
  const startRadiusRef = useRef<Map<string, number>>(new Map());
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    const start = startRadiusRef.current;
    const canAnimate =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      typeof requestAnimationFrame === 'function';
    const snap = start.size === 0 || reduced || !canAnimate;
    if (snap) {
      startRadiusRef.current = new Map(targetRadius);
      setProgress(1);
      return;
    }
    setProgress(0);
    const t0 = performance.now();
    const dur = 640;
    const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    let raf = requestAnimationFrame(function step(now: number) {
      const t = Math.min(1, (now - t0) / dur);
      setProgress(ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
      else startRadiusRef.current = new Map(targetRadius);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#519) animate only on centre change
  }, [center]);

  return useCallback(
    (physical: string): number => {
      const target = targetRadius.get(physical) ?? ORRERY.ringUnreached;
      if (progress >= 1) return target;
      const start = startRadiusRef.current.get(physical) ?? target;
      return start + (target - start) * progress;
    },
    [targetRadius, progress],
  );
}
