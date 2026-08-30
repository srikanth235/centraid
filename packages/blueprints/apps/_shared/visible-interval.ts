import { useEffect, useRef } from "react";

/** `tick` is read through a ref: a fresh closure must not reset the phase. */
export function useVisibleInterval(
  tick: () => void,
  ms: number,
  active: boolean
): void {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });

  useEffect(() => {
    if (!active) return undefined;
    let handle: ReturnType<typeof setInterval> | undefined;
    const visible = (): boolean =>
      typeof document === "undefined" || document.visibilityState !== "hidden";

    const start = (): void => {
      if (handle !== undefined) return;
      handle = setInterval(() => latest.current(), ms);
    };
    const stop = (): void => {
      if (handle === undefined) return;
      clearInterval(handle);
      handle = undefined;
    };
    const onVisibility = (): void => {
      if (!visible()) {
        stop();
        return;
      }
      // Catch up once: a clock that merely paused comes back a step behind.
      latest.current();
      start();
    };

    if (visible()) start();
    document.addEventListener?.("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener?.("visibilitychange", onVisibility);
    };
  }, [ms, active]);
}
