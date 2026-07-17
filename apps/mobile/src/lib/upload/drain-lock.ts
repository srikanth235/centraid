// One process-wide single-flight guard for EVERY drain entry point (#419 M0.4).
//
// The queue is safe to drain from anywhere, but two drains running at once
// re-PUT the same parts and double-count attempts. Before this guard the
// foreground reconciler, the Android headless task, and each media producer
// each opened their own queue and drained independently — the headless task in
// particular could spawn a drain on top of a live foreground one (F1/F8).
//
// Every caller routes through `withDrainLock`. It is a mutex, not a coalescer:
// each caller's own closure runs, but strictly one at a time, so a producer
// that just enqueued fresh bytes still gets a drain covering them.

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` after every previously-locked drain settles, and hand the next
 * caller a barrier that waits on this one. Errors are contained here so one
 * failed drain never wedges the chain; the caller still sees its own rejection.
 */
export function withDrainLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}
