import { describe, expect, test } from "vitest";

import {
  ASSET_CACHE,
  BLOB_CACHE,
  ORIGIN,
  bridgeClient,
  html,
  loadWorker,
  okHead,
  request,
  tunnelRequestFor,
} from "./sw-runtime.test-fixtures.js";
import type { Json } from "./sw-runtime.test-fixtures.js";

describe("service worker Iroh tunnel caching", () => {
  test("tunnels a virtual request through the owning tab instead of the network", async () => {
    const client = bridgeClient("tab-1", () => okHead("tunneled"));
    const worker = loadWorker({ clients: [client] });
    const response = await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/index.js"))
    );
    await expect(response.text()).resolves.toBe("tunneled");
    expect(worker.fetched).toStrictEqual([]);
  });

  test("caches a durable-scope asset that carries a validator", async () => {
    const client = bridgeClient("tab-1", () =>
      okHead("asset", { etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"))
    );
    const assets = worker.caches.buckets.get(ASSET_CACHE)!;
    expect([...assets.entries.keys()]).toStrictEqual([
      `${ORIGIN}/centraid/notes/app.js?__centraid_scope=d-bridge1&__centraid_app_scope=notes`,
    ]);
  });

  test("never caches an ephemeral (non-remembered) bridge scope", async () => {
    const client = bridgeClient("tab-1", () =>
      okHead("asset", { etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    const response = await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js", "e-ephemeral"))
    );
    await expect(response.text()).resolves.toBe("asset");
    expect(worker.caches.buckets.size).toBe(0);
  });

  test("never caches a Range request", async () => {
    const client = bridgeClient("tab-1", () =>
      okHead("asset", { etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    const response = await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"), {
        headers: { range: "bytes=0-10" },
      })
    );
    await expect(response.text()).resolves.toBe("asset");
    expect(worker.caches.buckets.size).toBe(0);
  });

  test("never caches a server-sent-event stream", async () => {
    const client = bridgeClient("tab-1", () =>
      okHead("data: hi", { "content-type": "text/event-stream", etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/events"))
    );
    expect(worker.caches.buckets.get(ASSET_CACHE)?.entries.size ?? 0).toBe(0);
  });

  test("never caches a no-store response", async () => {
    const client = bridgeClient("tab-1", () =>
      okHead("secret", { "cache-control": "no-store", etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/whoami"))
    );
    expect(worker.caches.buckets.get(ASSET_CACHE)?.entries.size ?? 0).toBe(0);
  });

  test("never caches an asset with no validator to revalidate against", async () => {
    const client = bridgeClient("tab-1", () => okHead("asset"));
    const worker = loadWorker({ clients: [client] });
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"))
    );
    expect(worker.caches.buckets.get(ASSET_CACHE)?.entries.size ?? 0).toBe(0);
  });

  test("never caches a non-200 status", async () => {
    const client = bridgeClient("tab-1", () => ({
      status: 206,
      headers: {
        "content-type": "text/plain",
        "content-length": "5",
        etag: '"v1"',
      },
      body: "asset",
    }));
    const worker = loadWorker({ clients: [client] });
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"))
    );
    expect(worker.caches.buckets.get(ASSET_CACHE)?.entries.size ?? 0).toBe(0);
  });

  test("drops both tunnel caches when the gateway rejects the app session", async () => {
    const client = bridgeClient("tab-1", () => ({
      status: 403,
      headers: { "content-type": "text/plain", "content-length": "6" },
      body: "denied",
    }));
    const worker = loadWorker({ clients: [client] });
    worker.caches.seed(ASSET_CACHE).entries.set(`${ORIGIN}/stale`, html("old"));
    worker.caches.seed(BLOB_CACHE).entries.set(`${ORIGIN}/blob`, html("old"));
    await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"))
    );
    await expect(worker.caches.keys()).resolves.toStrictEqual([]);
  });

  test("serves an already-cached asset from cache and keeps it on a 304", async () => {
    const client = bridgeClient("tab-1", (message) =>
      (message.headers as Json)?.["if-none-match"]
        ? { status: 304, headers: {} }
        : okHead("first bytes", { etag: '"v1"' })
    );
    const worker = loadWorker({ clients: [client] });
    const target = tunnelRequestFor("/centraid/notes/app.js");
    const first = await worker.dispatchFetch(request(target));
    await first.text();
    const second = await worker.dispatchFetch(request(target));
    await expect(second.text()).resolves.toBe("first bytes");
    const assets = worker.caches.buckets.get(ASSET_CACHE)!;
    const key = [...assets.entries.keys()][0]!;
    const cached = await assets.match(key);
    await expect(cached!.text()).resolves.toBe("first bytes");
  });

  test("replaces the cached asset when revalidation returns fresh bytes", async () => {
    let served = 0;
    const client = bridgeClient("tab-1", () => {
      served += 1;
      return okHead(`bytes ${served}`, { etag: `"v${served}"` });
    });
    const worker = loadWorker({ clients: [client] });
    const target = tunnelRequestFor("/centraid/notes/app.js");
    const first = await worker.dispatchFetch(request(target));
    await first.text();
    const second = await worker.dispatchFetch(request(target));
    await expect(second.text()).resolves.toBe("bytes 1");
    const third = await worker.dispatchFetch(request(target));
    await expect(third.text()).resolves.toBe("bytes 2");
  });

  test("serves an immutable blob from cache without re-fetching its bytes", async () => {
    const client = bridgeClient("tab-1", (message) =>
      (message.headers as Json)?.["if-none-match"]
        ? { status: 304, headers: {} }
        : okHead("blob bytes", { etag: '"b1"' })
    );
    const worker = loadWorker({ clients: [client] });
    const target = tunnelRequestFor("/centraid/_vault/blobs/sha256-abc");
    const first = await worker.dispatchFetch(request(target));
    await first.text();
    expect(worker.caches.buckets.get(BLOB_CACHE)!.entries.size).toBe(1);
    const second = await worker.dispatchFetch(request(target));
    await expect(second.text()).resolves.toBe("blob bytes");
  });

  test("rewrites a gateway redirect to a virtual URL without leaking the app-session cookie", async () => {
    const client = bridgeClient("tab-1", () => ({
      status: 302,
      headers: {
        location: "/centraid/notes/",
        "set-cookie": "centraid_app_session=secret; Path=/; HttpOnly",
      },
    }));
    const worker = loadWorker({ clients: [client] });
    const response = await worker.dispatchFetch(
      request(
        `${tunnelRequestFor("/centraid/_web/session")}?code=one-time&theme=dark`
      )
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/__centraid_iroh__/d-bridge1/centraid/notes/?theme=dark`
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("reports a tunnel failure as a 502 rather than a broken page", async () => {
    const worker = loadWorker({ clients: [] });
    const response = await worker.dispatchFetch(
      request(tunnelRequestFor("/centraid/notes/app.js"))
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Json;
    expect(body.error).toBe("iroh_tunnel_error");
  });
});
