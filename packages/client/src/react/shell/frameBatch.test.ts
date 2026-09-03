import { describe, expect, it, vi } from "vitest";

import { createFrameBatch } from "./frameBatch.js";
import type { FrameScheduler } from "./frameBatch.js";

function manualScheduler(): FrameScheduler & { tick: () => void } {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    request: (run) => {
      const handle = next++;
      pending.set(handle, run);
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
    tick: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const run of due) run();
    },
  };
}

describe(createFrameBatch, () => {
  it("collapses a burst of schedules into one run per frame", () => {
    const scheduler = manualScheduler();
    const run = vi.fn<() => void>();
    const batch = createFrameBatch(run, scheduler);
    for (let i = 0; i < 200; i++) batch.schedule();
    expect(run).not.toHaveBeenCalled();
    scheduler.tick();
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs again on the next frame after the first one landed", () => {
    const scheduler = manualScheduler();
    const run = vi.fn<() => void>();
    const batch = createFrameBatch(run, scheduler);
    batch.schedule();
    scheduler.tick();
    batch.schedule();
    scheduler.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("flush delivers the pending run immediately and only once", () => {
    const scheduler = manualScheduler();
    const run = vi.fn<() => void>();
    const batch = createFrameBatch(run, scheduler);
    batch.schedule();
    batch.flush();
    expect(run).toHaveBeenCalledOnce();
    scheduler.tick(); // the frame was cancelled, so nothing more arrives
    expect(run).toHaveBeenCalledOnce();
  });

  it("flush with nothing pending does not invent a run", () => {
    const scheduler = manualScheduler();
    const run = vi.fn<() => void>();
    createFrameBatch(run, scheduler).flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("cancel drops the pending run so a torn-down owner is never called", () => {
    const scheduler = manualScheduler();
    const run = vi.fn<() => void>();
    const batch = createFrameBatch(run, scheduler);
    batch.schedule();
    batch.cancel();
    scheduler.tick();
    expect(run).not.toHaveBeenCalled();
  });
});
