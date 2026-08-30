// Admission classes (#883 C2, at the #842 boundary): the class changes ONE
// decision — who leaves the queue next — and nothing else.

import { setTimeout } from "node:timers";

import { describe, expect, test } from "vitest";

import { unrefTimer } from "../../lib/unref-timer.js";
import { WorkerAdmission } from "./worker-admission.js";

// Settle every pending microtask so queued acquires observe their release.
function drain(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    unrefTimer(timer);
  });
}

describe("worker admission classes", () => {
  test("an interactive request leaves the queue before a background one", async () => {
    const admission = new WorkerAdmission(1, 8, 10_000);
    await admission.acquire("interactive"); // occupies the only slot

    const order: string[] = [];
    const first = admission
      .acquire("background")
      .then(() => void order.push("background-1"));
    const second = admission
      .acquire("background")
      .then(() => void order.push("background-2"));
    const third = admission
      .acquire("interactive")
      .then(() => void order.push("interactive"));

    await drain();
    expect(admission.stats()).toStrictEqual(
      expect.objectContaining({
        queued: 3,
        queuedInteractive: 1,
        queuedBackground: 2,
      })
    );

    admission.release();
    await drain();
    admission.release();
    await drain();
    admission.release();
    await Promise.all([first, second, third]);

    // FIFO still holds within the background class — the half priority must
    // not disturb.
    expect(order).toStrictEqual([
      "interactive",
      "background-1",
      "background-2",
    ]);
  });

  test("absent means interactive — the default is the one someone waits for", async () => {
    const admission = new WorkerAdmission(1, 8, 10_000);
    await admission.acquire();
    const order: string[] = [];
    const background = admission
      .acquire("background")
      .then(() => void order.push("background"));
    const unstated = admission
      .acquire()
      .then(() => void order.push("unstated"));
    await drain();
    admission.release();
    await drain();
    admission.release();
    await Promise.all([background, unstated]);
    expect(order).toStrictEqual(["unstated", "background"]);
  });

  test("neither class is refused earlier, and neither can starve silently", async () => {
    // The LENGTH bound is class-blind: a displaced background caller gets the
    // same typed `busy` refusal and retries, so priority is not starvation.
    const admission = new WorkerAdmission(1, 1, 10_000);
    await admission.acquire("interactive");
    const queued = admission.acquire("background");
    await drain();
    await expect(admission.acquire("interactive")).rejects.toThrow(
      /gateway busy/u
    );
    await expect(admission.acquire("background")).rejects.toThrow(
      /gateway busy/u
    );
    admission.release();
    await queued;
    admission.release();
    expect(admission.stats().queued).toBe(0);
  });

  test("a background waiter times out rather than waiting forever behind traffic", async () => {
    const admission = new WorkerAdmission(1, 8, 5);
    await admission.acquire("interactive");
    await expect(admission.acquire("background")).rejects.toThrow(
      /timed out waiting for a free worker slot/u
    );
    expect(admission.stats().queued).toBe(0);
    admission.release();
  });
});
