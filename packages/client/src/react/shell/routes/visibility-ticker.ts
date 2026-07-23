// Wakeup-hygiene helper (issue #528 Phase D). The Gateway route runs a 1s
// ticker to advance its running counters (uptime, "for 2h 14m"). Left naive it
// fires every second even while the tab is hidden — needless wakeups on a
// laptop on battery, the very thing the resource contract is trying to respect.
// This wires the same ticker but suspends it while the document is hidden and
// refreshes immediately on return. SSR-safe: with no `document`, it falls back
// to a plain always-on interval.

const TICK_INTERVAL_MS = 1000;

/**
 * Start a 1s ticker that calls `tick` each second while the page is visible,
 * pausing entirely while `document.visibilityState === 'hidden'` and firing
 * `tick` once immediately when the page becomes visible again. Returns a
 * teardown that clears the interval and detaches the listener.
 */
export function startVisibilityTicker(tick: () => void): () => void {
  if (typeof document === 'undefined') {
    const t = setInterval(tick, TICK_INTERVAL_MS);
    return () => clearInterval(t);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const start = (): void => {
    if (timer === null) timer = setInterval(tick, TICK_INTERVAL_MS);
  };
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else {
      tick(); // catch the counters up the moment the tab returns
      start();
    }
  };

  if (document.visibilityState !== 'hidden') start();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
