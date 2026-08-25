// Coalesce a burst of "state changed, re-project" calls into at most one run
// per animation frame (#659).
//
// The assistant stream fires an event per token. Re-projecting the WHOLE
// transcript per event and pushing it into React synchronously would make a
// 900-token answer do 900 full projections and 900 renders — work the display
// can never show, since it only paints ~60 times a second. Batching bounds that
// to one projection per frame while keeping the last write visible: the batched
// callback reads live state when it runs, so nothing is ever dropped, only
// skipped ahead of.
//
// `flush` exists for the moments where a frame of latency is wrong: a terminal
// event (turn finished, thread switched) should land before the next paint, and
// tests want a deterministic seam instead of a real frame.

export interface FrameBatch {
  /** Ask for a run on the next frame; repeated calls before it coalesce. */
  schedule: () => void;
  /** Run now if one is pending, cancelling the scheduled frame. */
  flush: () => void;
  /** Drop a pending run without executing it (teardown). */
  cancel: () => void;
}

export interface FrameScheduler {
  request: (run: () => void) => number;
  cancel: (handle: number) => void;
}

/**
 * The platform scheduler: `requestAnimationFrame` where it exists, and a
 * timer everywhere else (jsdom, a hidden tab whose rAF is suspended, SSR).
 */
export function defaultFrameScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === "function") {
    return {
      request: (run) => requestAnimationFrame(run),
      cancel: (handle) => cancelAnimationFrame(handle),
    };
  }
  return {
    request: (run) => setTimeout(run, 16) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  };
}

/** Batch calls to `run` to at most one per frame. */
export function createFrameBatch(
  run: () => void,
  scheduler: FrameScheduler = defaultFrameScheduler()
): FrameBatch {
  let handle: number | null = null;
  const clear = (): void => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
  };
  return {
    schedule: () => {
      if (handle !== null) return;
      handle = scheduler.request(() => {
        handle = null;
        run();
      });
    },
    flush: () => {
      if (handle === null) return;
      clear();
      run();
    },
    cancel: clear,
  };
}
