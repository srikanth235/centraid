import { describe, expect, it, vi } from "vitest";

import { optimisticUpdate } from "./optimisticUpdate.js";

function cell<T>(initial: T): { read: () => T; write: (next: T) => void } {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

describe(optimisticUpdate, () => {
  it("writes the edit before the commit resolves", async () => {
    const store = cell(["a"]);
    let released = (): void => undefined;
    const commit = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          released = resolve;
        })
    );
    const done = optimisticUpdate({
      ...store,
      apply: (previous) => [...previous, "b"],
      commit,
    });
    expect(store.read()).toStrictEqual(["a", "b"]);
    released();
    await done;
    expect(store.read()).toStrictEqual(["a", "b"]);
  });

  it("restores the exact pre-edit value when the commit rejects", async () => {
    const before = ["a", "b"];
    const store = cell(before);
    await expect(
      optimisticUpdate({
        ...store,
        apply: (previous) => previous.filter((v) => v !== "a"),
        commit: () => Promise.reject(new Error("gateway said no")),
      })
    ).rejects.toThrow("gateway said no");
    expect(store.read()).toBe(before);
  });

  it("reconciles through settle only after a successful commit", async () => {
    const store = cell(1);
    const settle = vi.fn<() => Promise<void>>(async () => {
      store.write(99);
    });
    await optimisticUpdate({
      ...store,
      apply: (previous) => previous + 1,
      commit: () => Promise.resolve(),
      settle,
    });
    expect(settle).toHaveBeenCalledOnce();
    expect(store.read()).toBe(99);
  });

  it("does not reconcile after a rejected commit", async () => {
    const store = cell(1);
    const settle = vi.fn<() => Promise<void>>(() => Promise.resolve());
    await expect(
      optimisticUpdate({
        ...store,
        apply: (previous) => previous + 1,
        commit: () => Promise.reject(new Error("nope")),
        settle,
      })
    ).rejects.toThrow("nope");
    expect(settle).not.toHaveBeenCalled();
    expect(store.read()).toBe(1);
  });
});
