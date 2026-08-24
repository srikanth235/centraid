// Wakeup-hygiene helper (#528). The Gateway route runs a 1s
// ticker to advance its running counters (uptime, "for 2h 14m"). Left naive it
// fires every second even while the tab is hidden — needless wakeups on a
// laptop on battery, the very thing the resource contract is trying to respect.
// This wires the same ticker but suspends it while the document is hidden and
// refreshes immediately on return. SSR-safe: with no `document`, it falls back
// to a plain always-on interval.

const TICK_INTERVAL_MS = 1000;

/**
 * Start a ticker that calls `tick` every `intervalMs` (1s by default) while the
 * page is visible, pausing entirely while `document.visibilityState ===
 * 'hidden'` and firing `tick` once immediately when the page becomes visible
 * again. Returns a teardown that clears the interval and detaches the listener.
 *
 * The interval became a parameter in #659: the running-counter ticker was
 * not the only poller in the shell that woke a backgrounded tab. Gateway
 * health, the notifications count, the device roster, backup and storage all
 * ran their own bare `setInterval`, so a tab left open in another window kept
 * a laptop's radio and CPU busy answering questions nobody was reading. Same
 * mechanism, different period.
 */
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
      tick(); // catch the counters up the moment the tab returns
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
