import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import type { FakeClock } from "@centraid/test-kit/fake-clock";

import {
  clearStatus,
  postStatus,
  readStatus,
  resetStatus,
  showUndoStatus,
  subscribeStatus,
} from "./statusChannel.js";

describe("the status channel", () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = useFakeClock();
    resetStatus();
  });
  afterEach(() => resetStatus());

  it("starts silent, so the line shows the route's ambient sentence", () => {
    expect(readStatus()).toBeNull();
  });

  it("updates IN PLACE — a second message supersedes the first", () => {
    // The whole point of one line is that messages never stack. A toast queue
    // is what this replaces.
    postStatus("Renamed · Groceries");
    postStatus("Deleted · Groceries");
    expect(readStatus()?.text).toBe("Deleted · Groceries");
  });

  it("notifies subscribers on every change, and stops on unsubscribe", () => {
    const seen: (string | null)[] = [];
    const off = subscribeStatus(() => seen.push(readStatus()?.text ?? null));
    postStatus("one");
    postStatus("two");
    clearStatus();
    off();
    postStatus("three");
    expect(seen).toStrictEqual(["one", "two", null]);
  });

  it("lets a bare confirmation decay back to the ambient line", () => {
    postStatus("Saved");
    expect(readStatus()?.text).toBe("Saved");
    clock.advanceSync(6000);
    expect(readStatus()).toBeNull();
  });

  it("keeps a note carrying progress standing until it is replaced", () => {
    postStatus("Importing", { progress: { done: 412, total: 1904 } });
    clock.advanceSync(60_000);
    expect(readStatus()?.progress).toStrictEqual({ done: 412, total: 1904 });
  });

  describe("the undo grace window", () => {
    it("offers the action, and commits when the window lapses", () => {
      const onUndo = vi.fn<() => void>();
      const onExpire = vi.fn<() => void>();
      showUndoStatus("Deleted “Groceries”", onUndo, { onExpire });
      expect(readStatus()?.action?.label).toBe("Undo");
      clock.advanceSync(6000);
      expect(onExpire).toHaveBeenCalledOnce();
      expect(onUndo).not.toHaveBeenCalled();
      expect(readStatus()).toBeNull();
    });

    it("reverts instead of committing when the action is taken", () => {
      const onUndo = vi.fn<() => void>();
      const onExpire = vi.fn<() => void>();
      showUndoStatus("Deleted “Groceries”", onUndo, { onExpire });
      readStatus()?.action?.run();
      expect(onUndo).toHaveBeenCalledOnce();
      clock.advanceSync(60_000);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("commits the previous window when a second one opens", () => {
      // A rapid second delete must not strand the first in limbo — there is
      // only one line, so there can only be one pending act on it.
      const firstExpire = vi.fn<() => void>();
      showUndoStatus("Deleted “A”", vi.fn<() => void>(), {
        onExpire: firstExpire,
      });
      showUndoStatus("Deleted “B”", vi.fn<() => void>(), {
        onExpire: vi.fn<() => void>(),
      });
      expect(firstExpire).toHaveBeenCalledOnce();
      expect(readStatus()?.text).toBe("Deleted “B”");
    });

    it("takes a custom label and window", () => {
      const onExpire = vi.fn<() => void>();
      showUndoStatus("Archived", vi.fn<() => void>(), {
        actionLabel: "Put back",
        durationMs: 1000,
        onExpire,
      });
      expect(readStatus()?.action?.label).toBe("Put back");
      clock.advanceSync(1000);
      expect(onExpire).toHaveBeenCalledOnce();
    });
  });
});
