const TICK_INTERVAL_MS = 1000;

export function startVisibilityTicker(
  tick: () => void,
  intervalMs: number = TICK_INTERVAL_MS
): () => void {
  if (typeof document === "undefined") {
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const start = (): void => {
    if (timer === null) timer = setInterval(tick, intervalMs);
  };
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      stop();
    } else {
      tick();
      start();
    }
  };

  if (document.visibilityState !== "hidden") start();
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
