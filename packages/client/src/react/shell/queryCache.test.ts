import { act, createElement, memo, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mutateQuery,
  peekQuery,
  resetQueryCache,
  revalidateQuery,
  useCachedQuery,
  writeQuery,
} from "./queryCache.js";
import type { QueryState } from "./queryCache.js";

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

  // ── referential stability (#883) ──────────────────────────────────────────
  //
  // The hook's result is handed down as a prop and depended on in effects, so a
  // fresh object per render is a re-render per frame in every consumer under it.
  describe("stable identity", () => {
    it("hands back the same object while nothing in the cache moves", async () => {
      const seen: unknown[] = [];
      const childRenders = { count: 0 };
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      // Written from an EFFECT: reassigning an outer binding during render is
      // the side effect the compiler rule forbids.
      const control: { bump: () => void } = { bump: () => undefined };

      // Memoized on the query result alone, so it re-renders exactly when that
      // identity changes — the cost under measurement.
      const Child = memo((_: { query: unknown }): null => {
        childRenders.count += 1;
        return null;
      });
      Child.displayName = "StabilityProbe";
      const Reader = (): ReactElement => {
        const [, setTick] = useState(0);
        useEffect(() => {
          control.bump = () => setTick((tick) => tick + 1);
        });
        const query = useCachedQuery("stable:a", () =>
          Promise.resolve(["one"])
        );
        seen.push(query);
        return createElement(Child, { query });
      };

      await act(async () => {
        root.render(createElement(Reader));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const settledRenders = childRenders.count;
      const settledIdentity = seen.at(-1);

      // Three parent renders that change nothing this hook reads.
      await act(async () => {
        control.bump();
      });
      await act(async () => {
        control.bump();
      });
      await act(async () => {
        control.bump();
      });

      expect(seen.at(-1)).toBe(settledIdentity);
      expect(childRenders.count).toBe(settledRenders);

      // A real change still propagates — stability is not staleness.
      await act(async () => {
        writeQuery("stable:a", ["two"]);
      });
      expect(seen.at(-1)).not.toBe(settledIdentity);
      expect(childRenders.count).toBe(settledRenders + 1);

      act(() => root.unmount());
      host.remove();
    });
  });

  // ── surviving a reload ────────────────────────────────────────────────────
  //
  // A reload — or the OS evicting an installed PWA — drops the JS context, so
  // without write-through every screen returns to skeletons. Simulated the only
  // honest way: `vi.resetModules()` and a fresh import, so the in-memory Map is
  // genuinely new while localStorage is not.
  describe("persisted keys", () => {
    type Mod = typeof import("./queryCache.js");

    /** A fresh module graph — a reload, as far as this cache is concerned. */
    async function reboot(): Promise<Mod> {
      vi.resetModules();
      return import("./queryCache.js");
    }

    /** Mount a persisted reader once and let it settle. */
    async function readOnce<T>(
      mod: Mod,
      key: string,
      load: () => Promise<T>,
      toPersisted?: (data: T) => T
    ): Promise<QueryState<T>> {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let last: QueryState<T> = { status: "loading", revalidating: true };
      const Reader = (): null => {
        last = mod.useCachedQuery(key, load, {
          persist: true,
          ...(toPersisted ? { toPersisted } : {}),
        }).state;
        return null;
      };
      await act(async () => {
        root.render(createElement(Reader));
      });
      await act(async () => {
        await Promise.resolve();
      });
      const settled = last;
      act(() => root.unmount());
      host.remove();
      return settled;
    }

    /** A load that never settles, so the persisted copy IS the paint. */
    const never = <T>(): Promise<T> =>
      new Promise<T>(() => {
        /* deliberately never resolves */
      });

    afterEach(() => localStorage.clear());

    it("paints from the written-through copy instead of starting cold", async () => {
      const first = await reboot();
      await readOnce(first, "home:x", () => Promise.resolve({ n: 1 }));

      // Everything in memory is gone; localStorage is not. This is a reload.
      const next = await reboot();
      const state = await readOnce(next, "home:x", () =>
        never<{ n: number }>()
      );
      // The FIRST paint already has data, and says it is refreshing behind it.
      expect(state).toStrictEqual({
        status: "ready",
        data: { n: 1 },
        revalidating: true,
      });
    });

    it("shapes the value on the way out — a handle that cannot survive is dropped", async () => {
      // `URL.createObjectURL` handles die with their document, so persisting
      // one paints a broken image on the very boot this speeds up.
      const first = await reboot();
      await readOnce(
        first,
        "home:y",
        () => Promise.resolve({ thumbs: ["blob:abc"], total: 9 }),
        (data) => ({ ...data, thumbs: [] })
      );
      const next = await reboot();
      const state = await readOnce(next, "home:y", () =>
        never<{ thumbs: string[]; total: number }>()
      );
      expect(state).toMatchObject({ data: { thumbs: [], total: 9 } });
    });

    it("forgets the written-through copies when the shell re-scopes", async () => {
      const mod = await reboot();
      await readOnce(mod, "home:z", () => Promise.resolve({ n: 1 }));
      expect(
        localStorage.getItem("centraid.v1.queryCache.home:z")
      ).not.toBeNull();
      // A different vault is a different world — a stale row painted into it
      // is a correctness bug, not a perf tradeoff.
      mod.resetQueryCache();
      expect(localStorage.getItem("centraid.v1.queryCache.home:z")).toBeNull();
    });

    it("survives a loader that resolves with nothing, and drops the stale copy", async () => {
      // `JSON.stringify(undefined)` is not a string, so the byte check must
      // stay inside the settle handler's try.
      const mod = await reboot();
      await readOnce(mod, "home:none", () => Promise.resolve({ n: 1 }));
      expect(
        localStorage.getItem("centraid.v1.queryCache.home:none")
      ).not.toBeNull();

      const state = await readOnce<{ n: number } | undefined>(
        mod,
        "home:none",
        () => Promise.resolve(undefined)
      );
      expect(state).toStrictEqual({
        status: "ready",
        data: undefined,
        revalidating: false,
      });
      expect(
        localStorage.getItem("centraid.v1.queryCache.home:none")
      ).toBeNull();
    });

    it("skips a value too big to belong in the origin's budget", async () => {
      const mod = await reboot();
      await readOnce(mod, "home:big", () =>
        Promise.resolve({ blob: "x".repeat(70 * 1024) })
      );
      expect(
        localStorage.getItem("centraid.v1.queryCache.home:big")
      ).toBeNull();
    });
  });
});
