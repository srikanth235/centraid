/** Trailing-debounce, no overlap: a signal during a run queues one guaranteed
 *  follow-up (dropping it would show stale UI).
 *
 *  AND `cancel()` REALLY CANCELS (#1014, P16). It used to clear the timer and
 *  the queued flag and leave an in-flight run alone, so teardown work outlived
 *  the mount that started it: a reachability pass mid-flight went on calling
 *  `updateGatewayBase`, `notifyReachable()` and `pullForeground()` on a closing
 *  session, and stored a base for a gateway the app had already switched away
 *  from. The run is handed an `AbortSignal` and `cancel()` aborts it; a run
 *  that awaits anything is expected to check it at each boundary. */
export interface CoalescedWork {
  signal: () => void;
  cancel: () => void;
}

export function coalesceWork(
  run: (signal: AbortSignal) => Promise<unknown>,
  windowMs: number
): CoalescedWork {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let controller: AbortController | undefined;

  const start = (): void => {
    timer = undefined;
    running = true;
    controller = new AbortController();
    void run(controller.signal).then(
      () => finish(),
      () => finish()
    );
  };

  const finish = (): void => {
    running = false;
    controller = undefined;
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
      // The in-flight run is TOLD, not merely forgotten: forgetting it is what
      // let a closing mount's work keep writing.
      controller?.abort();
      controller = undefined;
    },
  };
}
