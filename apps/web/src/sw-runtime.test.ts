import { describe, expect, test } from "vitest";

import {
  ASSET_CACHE,
  BLOB_CACHE,
  IROH_CONFIG_CACHE,
  NOTIFICATION_CACHE,
  ORIGIN,
  SHELL_CACHE,
  SHELL_PATHS,
  SHELL_ROUTES,
  html,
  loadWorker,
  request,
} from "./sw-runtime.test-fixtures.js";
import type { Json } from "./sw-runtime.test-fixtures.js";
import { SERVICE_WORKER_VERSION as VERSION } from "./sw-version.js";

describe("service worker cache identity", () => {
  test("precaches the shell under the cache name derived from the SW version", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    expect([...worker.caches.buckets.keys()]).toStrictEqual([SHELL_CACHE]);
    expect(SHELL_CACHE).toBe(`centraid-shell-${VERSION}`);
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    for (const entry of SHELL_PATHS) expect(shell.paths()).toContain(entry);
  });

  test("precaches the hashed assets referenced by index.html", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toContain("/assets/shell-aaa.css");
    expect(shell.paths()).toContain("/assets/entry-bbb.js");
  });

  test("install caches the required shell WITHOUT crawling lazy chunks", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toContain("/assets/entry-bbb.js");
    expect(shell.paths()).not.toContain("/assets/app-inline-ccc.js");
  });

  test("activate precaches lazy app chunks that only the entry JS references", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    await worker.runLifecycle("activate");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toContain("/assets/app-inline-ccc.js");
    expect(shell.paths()).toContain("/assets/app-inline-ccc.css");
  });

  test("activation still completes when a lazy chunk is missing", async () => {
    const { "/assets/app-inline-ccc.js": _missing, ...routes } = SHELL_ROUTES;
    const worker = loadWorker({ routes });
    await expect(worker.runLifecycle("install")).resolves.toBeUndefined();
    await expect(worker.runLifecycle("activate")).resolves.toBeUndefined();
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toContain("/assets/entry-bbb.js");
  });

  test("install asks to take over from the previous worker immediately", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    expect(worker.activationRequested()).toBe(false);
    await worker.runLifecycle("install");
    expect(worker.activationRequested()).toBe(true);
  });
});

describe("service worker activation", () => {
  test("deletes caches left behind by a previous version", async () => {
    const worker = loadWorker();
    worker.caches.seed("centraid-shell-v1");
    worker.caches.seed("centraid-tunnel-assets-v1");
    worker.caches.seed("centraid-tunnel-blobs-v1");
    await worker.runLifecycle("activate");
    await expect(worker.caches.keys()).resolves.toStrictEqual([]);
  });

  test("keeps every cache that belongs to the current version", async () => {
    const worker = loadWorker();
    for (const name of [
      SHELL_CACHE,
      ASSET_CACHE,
      BLOB_CACHE,
      IROH_CONFIG_CACHE,
      NOTIFICATION_CACHE,
      "centraid-shell-v1",
    ])
      worker.caches.seed(name);
    await worker.runLifecycle("activate");
    const surviving = (await worker.caches.keys()).sort();
    expect(surviving).toStrictEqual(
      [
        SHELL_CACHE,
        ASSET_CACHE,
        BLOB_CACHE,
        IROH_CONFIG_CACHE,
        NOTIFICATION_CACHE,
      ].sort()
    );
  });

  test("takes control of already-open pages", async () => {
    const worker = loadWorker();
    expect(worker.claimedClients()).toBe(false);
    await worker.runLifecycle("activate");
    expect(worker.claimedClients()).toBe(true);
  });
});

describe("service worker fetch routing", () => {
  test("serves a navigation from the shell cache without hitting the network", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const before = worker.fetched.length;
    const response = await worker.dispatchFetch(
      request("/", { mode: "navigate", destination: "document" })
    );
    await expect(response.text()).resolves.toContain("<html>");
    expect(worker.fetched.slice(before)).toStrictEqual(["/"]);
  });

  test("falls back to the offline page when an uncached navigation has no network", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const response = await worker.dispatchFetch(
      request("/deep/link", { mode: "navigate", destination: "document" })
    );
    await expect(response.text()).resolves.toBe("/offline.html");
  });

  test("answers an uncached navigation with an HTML 503 when even the shell is empty", async () => {
    const worker = loadWorker();
    const response = await worker.dispatchFetch(
      request("/deep/link", { mode: "navigate", destination: "document" })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("falls back to the app shell for an uncached sub-resource with no network", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const response = await worker.dispatchFetch(request("/assets/missing.js"));
    await expect(response.text()).resolves.toContain("<html>");
  });

  test("adds a same-origin static asset to the shell cache on first fetch", async () => {
    const worker = loadWorker({
      routes: { "/assets/late-ddd.js": () => html("late") },
    });
    const response = await worker.dispatchFetch(request("/assets/late-ddd.js"));
    await expect(response.text()).resolves.toBe("late");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toStrictEqual(["/assets/late-ddd.js"]);
  });

  test("caches a JS-initiated /assets fetch, which is how the wasm loads", async () => {
    const worker = loadWorker({
      routes: { "/assets/centraid_web_iroh_bg-abc.wasm": () => html("wasm") },
    });
    const response = await worker.dispatchFetch(
      request("/assets/centraid_web_iroh_bg-abc.wasm", { destination: "" })
    );
    await expect(response.text()).resolves.toBe("wasm");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toStrictEqual([
      "/assets/centraid_web_iroh_bg-abc.wasm",
    ]);
  });

  test("serves that wasm from the cache on the next visit, hitting no network at all", async () => {
    const worker = loadWorker({
      routes: { "/assets/centraid_web_iroh_bg-abc.wasm": () => html("wasm") },
    });
    const req = (): ReturnType<typeof request> =>
      request("/assets/centraid_web_iroh_bg-abc.wasm", { destination: "" });
    await worker.dispatchFetch(req());
    const before = worker.fetched.length;
    const response = await worker.dispatchFetch(req());
    await expect(response.text()).resolves.toBe("wasm");
    expect(worker.fetched.slice(before)).toStrictEqual([]);
  });

  test("caches the versioned worker WASM the page now loads", async () => {
    const worker = loadWorker({
      routes: { "/centraid-worker-iroh.wasm": () => html("wasm") },
    });
    const req = (): ReturnType<typeof request> =>
      request(`/centraid-worker-iroh.wasm?v=${VERSION}`, { destination: "" });
    const response = await worker.dispatchFetch(req());
    await expect(response.text()).resolves.toBe("wasm");
    const shell = worker.caches.buckets.get(SHELL_CACHE)!;
    expect(shell.paths()).toStrictEqual(["/centraid-worker-iroh.wasm"]);
    const before = worker.fetched.length;
    await expect(
      worker.dispatchFetch(req()).then(async (next) => next.text())
    ).resolves.toBe("wasm");
    expect(worker.fetched.slice(before)).toStrictEqual([]);
  });

  test("still revalidates a non-hashed shell entry in the background", async () => {
    const worker = loadWorker({ routes: SHELL_ROUTES });
    await worker.runLifecycle("install");
    const before = worker.fetched.length;
    const response = await worker.dispatchFetch(
      request("/manifest.webmanifest")
    );
    await expect(response.text()).resolves.toBe("/manifest.webmanifest");
    expect(worker.fetched.slice(before)).toStrictEqual([
      "/manifest.webmanifest",
    ]);
  });

  test("still passes a JS-initiated data request straight through, uncached", async () => {
    const worker = loadWorker({ routes: { "/api/thing": () => html("data") } });
    const response = await worker.dispatchFetch(
      request("/api/thing", { destination: "" })
    );
    await expect(response.text()).resolves.toBe("data");
    expect(worker.caches.buckets.get(SHELL_CACHE)?.paths() ?? []).toStrictEqual(
      []
    );
  });
});

describe("service worker never-cache rules", () => {
  test("never caches a cross-origin response", async () => {
    const worker = loadWorker({ routes: { "/cdn.js": () => html("vendor") } });
    const response = await worker.dispatchFetch(
      request("https://cdn.example.com/cdn.js")
    );
    await expect(response.text()).resolves.toBe("vendor");
    expect(worker.caches.buckets.get(SHELL_CACHE)?.entries.size ?? 0).toBe(0);
  });

  test("never caches a non-GET request and passes it straight to the network", async () => {
    const worker = loadWorker({
      routes: { "/centraid/_vault/sql": () => html("ok") },
    });
    const response = await worker.dispatchFetch(
      request("/centraid/_vault/sql", { method: "POST", destination: "" })
    );
    await expect(response.text()).resolves.toBe("ok");
    expect(worker.caches.buckets.size).toBe(0);
  });

  test("never caches an API request issued by fetch()/XHR", async () => {
    const worker = loadWorker({
      routes: { "/centraid/_vault/notifications": () => html("{}") },
    });
    const response = await worker.dispatchFetch(
      request("/centraid/_vault/notifications", { destination: "" })
    );
    await expect(response.text()).resolves.toBe("{}");
    expect(worker.caches.buckets.size).toBe(0);
  });

  test("never caches /web-config.json, so a dead gateway URL cannot be pinned", async () => {
    let served = 0;
    const worker = loadWorker({
      routes: {
        "/web-config.json": () => {
          served += 1;
          return html(`{"gateway":${served}}`);
        },
      },
    });
    const config = request("/web-config.json", { destination: "manifest" });
    const first = await worker.dispatchFetch(config);
    await expect(first.text()).resolves.toBe('{"gateway":1}');
    const second = await worker.dispatchFetch(config);
    await expect(second.text()).resolves.toBe('{"gateway":2}');
    expect(worker.caches.buckets.get(SHELL_CACHE)?.entries.size ?? 0).toBe(0);
  });
});

describe("service worker cache purge on unpair", () => {
  test("drops every tunnel cache but keeps the generic shell", async () => {
    const worker = loadWorker();
    for (const name of [
      SHELL_CACHE,
      ASSET_CACHE,
      BLOB_CACHE,
      IROH_CONFIG_CACHE,
    ])
      worker.caches.seed(name);
    const pending: Array<Promise<unknown>> = [];
    worker.listeners.get("message")?.({
      origin: ORIGIN,
      data: { type: "centraid:purge-tunnel-cache" },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as Json);
    await Promise.all(pending);
    const surviving = (await worker.caches.keys()).sort();
    expect(surviving).toStrictEqual([SHELL_CACHE]);
  });
});
