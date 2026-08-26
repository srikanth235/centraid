/** Trailing-debounce, no overlap: a signal during a run queues one guaranteed
 *  follow-up (dropping it would show stale UI). */
export interface CoalescedWork {
  signal: () => void;
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
