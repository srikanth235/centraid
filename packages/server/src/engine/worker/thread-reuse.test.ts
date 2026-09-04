import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  MAX_RUNS_PER_WORKER,
  bindHostFetch,
  createGlobalScrubber,
  createThreadSession,
  handlerImportHref,
  runResultFlags,
} from "./thread-reuse.js";

describe("global scrubber", () => {
  test("the first call captures a baseline and leaves planted keys in place", () => {
    const scope: Record<PropertyKey, unknown> = { owned: 1 };
    const scrub = createGlobalScrubber();
    scope.planted = 2;
    scrub(scope);
    expect(scope).toStrictEqual({ owned: 1, planted: 2 });
  });

  test("a later call deletes configurable plants and keeps the baseline", () => {
    const scope: Record<PropertyKey, unknown> = { owned: 1 };
    const scrub = createGlobalScrubber();
    scrub(scope);
    scope.planted = 2;
    scrub(scope);
    expect(scope).toStrictEqual({ owned: 1 });
  });

  test("an omitted scope scrubs globalThis", () => {
    const scrub = createGlobalScrubber();
    const key = Symbol("centraid-thread-reuse-plant");
    scrub();
    (globalThis as Record<PropertyKey, unknown>)[key] = 1;
    scrub();
    expect(key in globalThis).toBe(false);
  });

  test("a non-configurable plant survives because it is not ours to remove", () => {
    const scope: Record<PropertyKey, unknown> = { owned: 1 };
    const scrub = createGlobalScrubber();
    scrub(scope);
    Object.defineProperty(scope, "locked", {
      value: 2,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    scope.planted = 3;
    scrub(scope);
    expect(scope.owned).toBe(1);
    expect(scope.locked).toBe(2);
    expect("planted" in scope).toBe(false);
  });
});

describe("per-run handler href", () => {
  test("the query key differs per run so the registry cannot reuse a graph", () => {
    const file = "/tmp/apps/notes/queries/library.js";
    const href = handlerImportHref(file, 7);
    expect(href).toBe(`${pathToFileURL(file).href}?centraid-run=7`);
    expect(handlerImportHref(file, 8)).not.toBe(href);
  });
});

describe("run result flags", () => {
  test("an empty key and a young thread report nothing extra", () => {
    expect(runResultFlags(undefined, 1)).toStrictEqual({});
  });

  test("the installed lane is reported so the pool parks under it", () => {
    expect(runResultFlags("app-handler", 1)).toStrictEqual({
      sandboxKey: "app-handler",
    });
  });

  test("the run budget retires the thread at the cap, not before", () => {
    expect(
      runResultFlags("app-handler", MAX_RUNS_PER_WORKER - 1)
    ).toStrictEqual({ sandboxKey: "app-handler" });
    expect(runResultFlags("app-handler", MAX_RUNS_PER_WORKER)).toStrictEqual({
      sandboxKey: "app-handler",
      retire: true,
    });
    expect(runResultFlags(undefined, MAX_RUNS_PER_WORKER + 1)).toStrictEqual({
      retire: true,
    });
  });
});

describe("host fetch binding", () => {
  test("every call forwards the run's signal, even over a caller-supplied one", async () => {
    const run = new AbortController();
    const caller = new AbortController();
    const seen: AbortSignal[] = [];
    const hostFetch: typeof fetch = (input, init) => {
      seen.push(init?.signal as AbortSignal);
      expect(input).toBe("https://example.test/");
      return Promise.resolve(new Response("ok"));
    };
    const fetch = bindHostFetch(hostFetch, run.signal);
    await fetch("https://example.test/", { signal: caller.signal });
    await fetch("https://example.test/");
    expect(seen).toStrictEqual([run.signal, run.signal]);
  });
});

describe("thread session", () => {
  test("each beginRun hands a live signal; finish aborts the previous one", () => {
    const session = createThreadSession();
    const first = session.beginRun();
    expect(first.runOrdinal).toBe(1);
    expect(first.signal.aborted).toBe(false);
    expect(session.signal).toBe(first.signal);
    const pending = new Map([[1, "rpc"]]);
    session.finish(pending);
    expect(first.signal.aborted).toBe(true);
    expect(pending.size).toBe(0);
    const second = session.beginRun();
    expect(second.runOrdinal).toBe(2);
    expect(second.signal.aborted).toBe(false);
    expect(second.signal).not.toBe(first.signal);
  });

  test("abort marks the live signal with the parent's reason", () => {
    const session = createThreadSession();
    const { signal } = session.beginRun();
    session.abort("timed out");
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason)).toMatch(/timed out/u);
  });

  test("finish drops pending RPCs and does not reject them", () => {
    const session = createThreadSession();
    session.beginRun();
    let rejected = false;
    const pending = new Map([
      [
        1,
        {
          reject: () => {
            rejected = true;
          },
        },
      ],
    ]);
    session.finish(pending);
    expect(pending.size).toBe(0);
    expect(rejected).toBe(false);
  });

  test("importHref and resultFlags follow the session's run ordinal", () => {
    const session = createThreadSession();
    const file = "/tmp/handler.js";
    for (let n = 1; n < MAX_RUNS_PER_WORKER; n++) session.beginRun();
    expect(session.resultFlags("app-handler")).toStrictEqual({
      sandboxKey: "app-handler",
    });
    session.beginRun();
    expect(session.runsServed).toBe(MAX_RUNS_PER_WORKER);
    expect(session.importHref(file)).toBe(
      `${pathToFileURL(file).href}?centraid-run=${MAX_RUNS_PER_WORKER}`
    );
    expect(session.resultFlags("app-handler")).toStrictEqual({
      sandboxKey: "app-handler",
      retire: true,
    });
  });
});
