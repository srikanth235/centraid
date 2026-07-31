import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mutateQuery,
  peekQuery,
  resetQueryCache,
  revalidateQuery,
  writeQuery,
} from "./queryCache.js";

describe("queryCache", () => {
  // The cache is module state on purpose — outliving the component is the whole
  // point — so each test starts from a cleared one.
  afterEach(() => resetQueryCache());

  it("keeps a settled value for the next reader instead of refetching cold", async () => {
    const load = vi.fn<() => Promise<string[]>>(() => Promise.resolve(["one"]));
    await revalidateQuery("runs:a", load);
    expect(peekQuery<string[]>("runs:a")).toStrictEqual({
      status: "ready",
      data: ["one"],
      revalidating: false,
    });
  });

  it("shows the cached value while a revalidation is in flight", async () => {
    await revalidateQuery("runs:a", () => Promise.resolve(["one"]));
    let release = (): void => undefined;
    const slow = revalidateQuery(
      "runs:a",
      () =>
        new Promise<string[]>((resolve) => {
          release = () => resolve(["two"]);
        })
    );
    const during = peekQuery<string[]>("runs:a");
    expect(during?.data).toStrictEqual(["one"]);
    expect(during?.revalidating).toBe(true);
    release();
    await slow;
    expect(peekQuery<string[]>("runs:a")?.data).toStrictEqual(["two"]);
  });

  it("coalesces concurrent revalidations of the same key onto one fetch", async () => {
    const load = vi.fn<() => Promise<number>>(() => Promise.resolve(1));
    await Promise.all([
      revalidateQuery("n", load),
      revalidateQuery("n", load),
      revalidateQuery("n", load),
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps the last good value when a revalidation fails", async () => {
    await revalidateQuery("runs:a", () => Promise.resolve(["one"]));
    await revalidateQuery("runs:a", () => Promise.reject(new Error("offline")));
    const state = peekQuery<string[]>("runs:a");
    expect(state?.status).toBe("ready");
    expect(state?.data).toStrictEqual(["one"]);
    expect(state?.error).toBe("offline");
  });

  it("reports error status only when nothing ever settled for the key", async () => {
    await revalidateQuery("cold", () => Promise.reject(new Error("boom")));
    expect(peekQuery("cold")).toStrictEqual({
      status: "error",
      error: "boom",
      revalidating: false,
    });
  });

  it("applies a mutation locally before the commit resolves", async () => {
    await revalidateQuery("list", () =>
      Promise.resolve([{ id: "a", pinned: false }])
    );
    let release = (): void => undefined;
    const pending = mutateQuery<{ id: string; pinned: boolean }[]>(
      "list",
      (rows) => rows.map((r) => ({ ...r, pinned: true })),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    expect(peekQuery<{ pinned: boolean }[]>("list")?.data?.[0]?.pinned).toBe(
      true
    );
    release();
    await pending;
  });

  it("rolls a mutation back and rethrows when the commit rejects", async () => {
    await revalidateQuery("list", () => Promise.resolve(["a"]));
    await expect(
      mutateQuery<string[]>(
        "list",
        (rows) => [...rows, "b"],
        () => Promise.reject(new Error("denied"))
      )
    ).rejects.toThrow("denied");
    expect(peekQuery<string[]>("list")?.data).toStrictEqual(["a"]);
  });

  it("revalidates after a successful mutation so the guess is replaced", async () => {
    await revalidateQuery("list", () => Promise.resolve(["a"]));
    await mutateQuery<string[]>(
      "list",
      (rows) => [...rows, "guess"],
      () => Promise.resolve(),
      () => Promise.resolve(["a", "server"])
    );
    expect(peekQuery<string[]>("list")?.data).toStrictEqual(["a", "server"]);
  });

  it("notifies subscribers when a value changes", async () => {
    const seen: unknown[] = [];
    await revalidateQuery("list", () => Promise.resolve(["a"]));
    writeQuery("list", ["b"]);
    seen.push(peekQuery<string[]>("list")?.data);
    expect(seen).toStrictEqual([["b"]]);
  });

  it("drops everything on a re-scope so the previous vault's rows cannot show", async () => {
    await revalidateQuery("apps", () => Promise.resolve(["vault-a app"]));
    resetQueryCache();
    expect(peekQuery("apps")).toBeUndefined();
  });

  it("can drop a single family by prefix without clearing unrelated keys", async () => {
    await revalidateQuery("runs:a", () => Promise.resolve(["a"]));
    await revalidateQuery("apps", () => Promise.resolve(["app"]));
    resetQueryCache("runs:");
    expect(peekQuery("runs:a")).toBeUndefined();
    expect(peekQuery<string[]>("apps")?.data).toStrictEqual(["app"]);
  });
});
