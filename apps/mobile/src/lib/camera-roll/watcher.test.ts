// The frame watcher's serialization and its honest trigger table. The React
// mount half is not exercised here: what makes the watcher correct is that one
// sweep runs at a time and a listener burst cannot re-enter it.

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  CAMERA_ROLL_MIN_INTERVAL_MS,
  CAMERA_ROLL_TRIGGERS,
  mayRunSweep,
  registerCameraRollSweep,
  resetCameraRollWatcher,
  runCameraRollSweep,
  setCameraRollScope,
} from "./watcher";
import type { CameraRollScope } from "./watcher";

const SCOPE = {
  session: {} as CameraRollScope["session"],
  gatewayBase: "https://gateway.test",
};

describe("the frame camera-roll watcher", () => {
  beforeEach(() => {
    resetCameraRollWatcher();
  });

  describe("running a sweep", () => {
    test("nothing runs before a scope exists — an unpaired phone is not a failure", async () => {
      const sweep = vi.fn<() => Promise<void>>(async () => undefined);
      registerCameraRollSweep(sweep);
      await expect(runCameraRollSweep("app-start")).resolves.toBe(false);
      expect(sweep).not.toHaveBeenCalled();
    });

    test("the registered sweep gets the frame's live scope", async () => {
      const sweep = vi.fn<() => Promise<void>>(async () => undefined);
      registerCameraRollSweep(sweep);
      setCameraRollScope(SCOPE);
      await expect(runCameraRollSweep("foreground")).resolves.toBe(true);
      expect(sweep).toHaveBeenCalledWith(SCOPE);
    });

    test("a second registration replaces the first rather than stacking", async () => {
      const first = vi.fn<() => Promise<void>>(async () => undefined);
      const second = vi.fn<() => Promise<void>>(async () => undefined);
      registerCameraRollSweep(first);
      registerCameraRollSweep(second);
      setCameraRollScope(SCOPE);
      await runCameraRollSweep("app-start");
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    test("a throwing sweep is reported, not propagated — the queue carries the work", async () => {
      registerCameraRollSweep(async () => {
        throw new Error("the walk failed");
      });
      setCameraRollScope(SCOPE);
      await expect(runCameraRollSweep("app-start")).resolves.toBe(false);
    });

    test("two triggers cannot run one sweep twice at once", async () => {
      let release = (): void => {};
      const started: number[] = [];
      registerCameraRollSweep(async () => {
        started.push(Date.now());
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      setCameraRollScope(SCOPE);
      const first = runCameraRollSweep("app-start");
      const second = await runCameraRollSweep("foreground");
      expect(second).toBe(false);
      release();
      await first;
      expect(started).toHaveLength(1);
    });
  });

  describe(mayRunSweep, () => {
    test("a running sweep blocks every reason", () => {
      for (const reason of CAMERA_ROLL_TRIGGERS.map((t) => t.reason))
        expect(
          mayRunSweep(reason, { running: true, lastRunAt: 0 }, 10 ** 12)
        ).toBe(false);
    });

    test("a library-change burst is rate-limited", () => {
      const now = 10 ** 12;
      expect(
        mayRunSweep("library-changed", { running: false, lastRunAt: now }, now)
      ).toBe(false);
      expect(
        mayRunSweep(
          "library-changed",
          { running: false, lastRunAt: now - CAMERA_ROLL_MIN_INTERVAL_MS },
          now
        )
      ).toBe(true);
    });

    test("an explicit reason is never rate-limited — the member or the OS asked", () => {
      const now = 10 ** 12;
      expect(
        mayRunSweep("foreground", { running: false, lastRunAt: now }, now)
      ).toBe(true);
      expect(
        mayRunSweep("app-start", { running: false, lastRunAt: now }, now)
      ).toBe(true);
    });
  });

  describe("the trigger table is honest", () => {
    test("every reason declares both when it fires and when it cannot", () => {
      for (const trigger of CAMERA_ROLL_TRIGGERS) {
        expect(trigger.fires.length).toBeGreaterThan(0);
        expect(trigger.cannot.length).toBeGreaterThan(0);
      }
    });

    test("the background pass does NOT claim to discover new photographs", () => {
      const background = CAMERA_ROLL_TRIGGERS.find(
        (trigger) => trigger.reason === "background-pass"
      );
      // It drains the durable queue and nothing more. A table that implied
      // otherwise would be the promise this slice exists not to make.
      expect(background?.fires).toContain("never");
    });
  });
});
