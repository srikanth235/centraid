// At most one run per animation frame (#659); `flush` covers terminal events
// and tests.

export interface FrameBatch {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
}

export interface FrameScheduler {
  request: (run: () => void) => number;
  cancel: (handle: number) => void;
}

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
