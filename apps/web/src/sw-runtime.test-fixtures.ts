import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { SERVICE_WORKER_VERSION as VERSION } from "./sw-version.js";

// `public/sw.js` is a classic, IIFE-wrapped service worker: it has no exports
// and cannot be imported. It is evaluated in a `node:vm` context whose globals
// are the fakes below (the same technique sw-notifications-wake.test.ts uses), with the
// real file path as the script filename so v8 attributes coverage to it.
//
// Split out of `sw-runtime.test.ts` (#656 Layer 1F) so the shell/caching laws
// and the Iroh tunnel laws are separate files, neither over the size cap.
export const SW_PATH = path.join(import.meta.dirname, "../public/sw.js");
export const SW_SOURCE = readFileSync(SW_PATH, "utf8");

export const ORIGIN = "https://app.centraid.dev";
export const SHELL_CACHE = `centraid-shell-${VERSION}`;
export const ASSET_CACHE = `centraid-tunnel-assets-${VERSION}`;
export const BLOB_CACHE = `centraid-tunnel-blobs-${VERSION}`;
export const IROH_CONFIG_CACHE = "centraid-worker-iroh-config-v1";
export const NOTIFICATION_CACHE = "centraid-private-notification-delivery-v1";

// Every path the worker hard-codes as its offline shell.
export const SHELL_PATHS = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/centraid.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon-180.png",
];

export type Json = Record<string, unknown>;
export type SwEventListener = (event: Json) => void;

export const absolute = (key: unknown): string => {
  const raw = typeof key === "string" ? key : (key as { url: string }).url;
  return new URL(raw, ORIGIN).toString();
};

export type FakeCache = {
  entries: Map<string, Response>;
  match: (key: unknown) => Promise<Response | undefined>;
  put: (key: unknown, response: Response) => Promise<void>;
  add: (key: unknown) => Promise<void>;
  addAll: (keys: readonly unknown[]) => Promise<void>;
  keys: () => Promise<string[]>;
  delete: (key: unknown) => Promise<boolean>;
  paths: () => string[];
};

/** Minimal Cache keyed by absolute URL, like the real API. */
export const createCache = (
  netFetch: (url: string) => Promise<Response>
): FakeCache => {
  const entries = new Map<string, Response>();
  const add = async (key: unknown): Promise<void> => {
    const response = await netFetch(absolute(key));
    if (!response.ok) throw new Error(`precache failed for ${absolute(key)}`);
    entries.set(absolute(key), response);
  };
  return {
    entries,
    add,
    async match(key: unknown) {
      return entries.get(absolute(key))?.clone();
    },
    async put(key: unknown, response: Response) {
      entries.set(absolute(key), response);
    },
    async addAll(keys: readonly unknown[]) {
      await Promise.all(keys.map(async (key) => add(key)));
    },
    // The real API hands back Request objects; the worker only ever feeds these
    // straight back into match()/delete(), which accept our string keys.
    async keys() {
      return [...entries.keys()];
    },
    async delete(key: unknown) {
      return entries.delete(absolute(key));
    },
    paths() {
      return [...entries.keys()].map((url) => new URL(url).pathname);
    },
  };
};

export type FakeCacheStorage = {
  buckets: Map<string, FakeCache>;
  open: (name: string) => Promise<FakeCache>;
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
  seed: (name: string) => FakeCache;
};

export const createCacheStorage = (
  netFetch: (url: string) => Promise<Response>
): FakeCacheStorage => {
  const buckets = new Map<string, FakeCache>();
  return {
    buckets,
    async open(name: string) {
      const existing = buckets.get(name);
      if (existing) return existing;
      const created = createCache(netFetch);
      buckets.set(name, created);
      return created;
    },
    async keys() {
      return [...buckets.keys()];
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
    seed(name: string) {
      const created = createCache(netFetch);
      buckets.set(name, created);
      return created;
    },
  };
};

export type FakePort = {
  peer?: FakePort;
  closed: boolean;
  addEventListener: (
    type: string,
    listener: (event: { data: Json }) => void
  ) => void;
  start: () => void;
  postMessage: (data: Json) => void;
  close: () => void;
  deliverLater: () => void;
  notifications: Json[];
};

/**
 * In-process MessagePort pair for the tunnel bridge. Each frame is delivered in
 * its own macrotask, exactly like a real port: that is what lets the worker
 * attach its body-stream listener (a microtask after the `head` frame) before
 * the first `chunk` frame arrives.
 */
export const createPort = (): FakePort => {
  const listeners: Array<(event: { data: Json }) => void> = [];
  const notifications: Json[] = [];
  let started = false;
  let draining = false;
  const port: FakePort = {
    closed: false,
    notifications,
    addEventListener(_type: string, listener: (event: { data: Json }) => void) {
      listeners.push(listener);
    },
    start() {
      if (started) return;
      started = true;
      port.deliverLater();
    },
    postMessage(data: Json) {
      port.peer?.notifications.push(data);
      port.peer?.deliverLater();
    },
    close() {
      port.closed = true;
    },
    deliverLater() {
      if (!started || draining || notifications.length === 0) return;
      draining = true;
      setTimeout(() => {
        draining = false;
        const next = notifications.shift();
        if (next !== undefined)
          for (const listener of listeners) listener({ data: next });
        port.deliverLater();
      }, 0);
    },
  };
  return port;
};

class FakeMessageChannel {
  readonly port1: FakePort;
  readonly port2: FakePort;

  constructor() {
    this.port1 = createPort();
    this.port2 = createPort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

export type FakeRequest = {
  url: string;
  method: string;
  mode: string;
  destination: string;
  headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export const request = (
  url: string,
  init: Partial<Omit<FakeRequest, "headers">> & {
    headers?: Record<string, string>;
  } = {}
): FakeRequest => ({
  url: new URL(url, ORIGIN).toString(),
  method: init.method ?? "GET",
  mode: init.mode ?? "no-cors",
  destination: init.destination ?? "script",
  headers: new Headers(init.headers ?? {}),
  arrayBuffer: async () => new ArrayBuffer(0),
});

export type TunnelHead = {
  status: number;
  headers: Record<string, string | string[]>;
  body?: string;
};

export type BridgeClient = {
  id: string;
  url: string;
  postMessage: (data: Json, transfer?: FakePort[]) => void;
  focus: () => Promise<void>;
};

/**
 * A shell tab that owns an Iroh bridge: answers the claim handshake and
 * replies to `centraid:iroh-request` with one head frame + one body chunk.
 */
export const bridgeClient = (
  id: string,
  reply: (message: Json) => TunnelHead
): BridgeClient => ({
  id,
  url: `${ORIGIN}/`,
  focus: async () => undefined,
  postMessage(data: Json, transfer?: FakePort[]) {
    const port = transfer?.[0];
    if (!port) return;
    if (data.type === "centraid:iroh-claim") {
      port.postMessage({ type: "claim" });
      return;
    }
    if (data.type !== "centraid:iroh-request") return;
    const head = reply(data);
    port.postMessage({
      type: "head",
      status: head.status,
      headers: head.headers,
    });
    if (head.body !== undefined) {
      port.postMessage({
        type: "chunk",
        body: new TextEncoder().encode(head.body).buffer,
      });
    }
    port.postMessage({ type: "end" });
  },
});

export type WorkerOptions = {
  routes?: Record<string, () => Response>;
  clients?: BridgeClient[];
};

export type Worker = {
  listeners: Map<string, SwEventListener>;
  caches: FakeCacheStorage;
  fetched: string[];
  activationRequested: () => boolean;
  claimedClients: () => boolean;
  dispatchFetch: (
    req: FakeRequest,
    options?: { clientId?: string }
  ) => Promise<Response>;
  runLifecycle: (name: "install" | "activate") => Promise<void>;
};

export const loadWorker = (options: WorkerOptions = {}): Worker => {
  const listeners = new Map<string, SwEventListener>();
  const fetched: string[] = [];
  let activationRequested = false;
  let claimed = false;

  const netFetch = async (input: unknown): Promise<Response> => {
    const url = new URL(absolute(input));
    fetched.push(url.pathname + url.search);
    const route = options.routes?.[url.pathname];
    if (!route) throw new TypeError("Failed to fetch");
    return route();
  };

  const caches = createCacheStorage(netFetch);
  const windowClients = options.clients ?? [];

  const self = {
    location: { origin: ORIGIN },
    registration: {
      navigationPreload: { enable: async () => undefined },
      showNotification: async () => undefined,
    },
    clients: {
      claim: async () => {
        claimed = true;
      },
      get: async (id: string) =>
        windowClients.find((client) => client.id === id),
      matchAll: async () => windowClients,
      openWindow: async () => undefined,
    },
    addEventListener: (name: string, listener: SwEventListener) => {
      listeners.set(name, listener);
    },
    skipWaiting: () => {
      activationRequested = true;
    },
  };

  vm.runInNewContext(
    SW_SOURCE,
    {
      self,
      caches,
      fetch: netFetch,
      importScripts: () => undefined,
      atob,
      Response,
      Headers,
      URL,
      ReadableStream,
      DecompressionStream,
      MessageChannel: FakeMessageChannel,
      TextEncoder,
      setTimeout,
      clearTimeout,
      console,
    },
    { filename: SW_PATH }
  );

  const runLifecycle = async (name: "install" | "activate"): Promise<void> => {
    const pending: Array<Promise<unknown>> = [];
    listeners.get(name)?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as Json);
    await Promise.all(pending);
  };

  const dispatchFetch = async (
    req: FakeRequest,
    dispatchOptions: { clientId?: string } = {}
  ): Promise<Response> => {
    const pending: Array<Promise<unknown>> = [];
    let responded: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: req,
      clientId: dispatchOptions.clientId,
      preloadResponse: Promise.resolve(undefined),
      respondWith: (promise: Promise<Response>) => {
        responded = promise;
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as Json);
    const response = await responded!;
    await Promise.all(pending.map(async (task) => task.catch(() => undefined)));
    return response;
  };

  return {
    listeners,
    caches,
    fetched,
    activationRequested: () => activationRequested,
    claimedClients: () => claimed,
    dispatchFetch,
    runLifecycle,
  };
};

export const html = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export const INDEX_HTML =
  '<html><head><link rel="stylesheet" href="/assets/shell-aaa.css">' +
  '<script type="module" src="/assets/entry-bbb.js"></script></head><body></body></html>';

export const SHELL_ROUTES: Record<string, () => Response> = Object.fromEntries([
  ...SHELL_PATHS.map((entry) => [
    entry,
    () => html(entry === "/" ? INDEX_HTML : entry),
  ]),
  ["/assets/shell-aaa.css", () => html("body{}")],
  [
    "/assets/entry-bbb.js",
    () => html('import("assets/app-inline-ccc.js");"assets/shell-aaa.css"'),
  ],
  ["/assets/app-inline-ccc.js", () => html('"assets/app-inline-ccc.css"')],
  ["/assets/app-inline-ccc.css", () => html(".app{}")],
]);

export const tunnelRequestFor = (
  target: string,
  bridgeId = "d-bridge1"
): string => `/__centraid_iroh__/${bridgeId}${target}`;

export const okHead = (
  body: string,
  headers: Record<string, string> = {}
): TunnelHead => ({
  status: 200,
  headers: {
    "content-type": "text/plain",
    "content-length": String(body.length),
    ...headers,
  },
  body,
});
