/**
 * Collapse a burst of "something changed" signals into one run of the work.
 *
 * A replica delta pull applies many invalidations in a row, and one read per
 * signal means a 200-row change batch costs 200 full mounted reads, every one
 * of them re-parsing the projection and re-rendering the tree. The
 * signals are not individually meaningful — they all say "re-read" — so the
 * honest shape is a trailing debounce that also refuses to overlap itself.
 *
 * Two rules, both load-bearing:
 *
 * - **Trailing window.** Signals inside `windowMs` produce exactly one run,
 *   started after the burst goes quiet, so the run reads settled state rather
 *   than a torn intermediate one.
 * - **No overlap, no loss.** A signal that arrives while a run is in flight
 *   queues exactly one follow-up run, however many arrive. The follow-up is
 *   guaranteed: dropping it would leave the UI showing pre-change data.
 */
export interface CoalescedWork {
  /** Ask for a run. Cheap; safe to call from a hot listener. */
  signal: () => void;
  /** Drop any scheduled run. An in-flight run is left to settle. */
  cancel: () => void;
}

export function coalesceWork(
  run: () => Promise<unknown>,
  windowMs: number
): CoalescedWork {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;

  const start = (): void => {
    timer = undefined;
    running = true;
    void run().then(
      () => finish(),
      () => finish()
    );
  };

  const finish = (): void => {
    running = false;
    if (!queued) return;
    queued = false;
    schedule();
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(start, windowMs);
  };

  return {
    signal: () => {
      if (running) {
        queued = true;
        return;
      }
      schedule();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      queued = false;
    },
  };
}
