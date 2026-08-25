import initWasm, {
  BrowserEndpoint,
  connect_failure_marker,
} from "./generated/centraid_web_iroh.js";
import type { BrowserResponse } from "./generated/centraid_web_iroh.js";
import {
  irohStats,
  markConnectStart,
  measureConnect,
  measureRequest,
  nowMs,
} from "./iroh-metrics.js";
import { SERVICE_WORKER_VERSION } from "./sw-version.js";
import { loadConnection, webGatewayId } from "./web-state.js";

const KEY_STORAGE = "centraid.web.v1.iroh-device-key";
const BRIDGE_STORAGE = "centraid.web.v1.iroh-bridge";
const VIRTUAL_PREFIX = "/__centraid_iroh__/";
// Versioned: an older shell worker must not read as ready.
const SERVICE_WORKER_URL = `/sw.js?v=${SERVICE_WORKER_VERSION}`;

// The WASM layer already redials once, so failures here pause first.
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 750];
// Bounds connect + send + first-header, never the body stream.
const CONNECT_TIMEOUT_MS = 15_000;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

let endpointPromise: Promise<BrowserEndpoint> | undefined;

function decodeBytes(raw: string): Uint8Array {
  return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function endpoint(): Promise<BrowserEndpoint> {
  const stored = adoptDurableIrohDeviceKey();
  if (!endpointPromise) {
    endpointPromise = (async () => {
      const connectStart = markConnectStart();
      await initWasm();
      const node = await BrowserEndpoint.spawn(
        stored ? decodeBytes(stored) : undefined,
        undefined
      );
      if (!stored)
        localStorage.setItem(KEY_STORAGE, encodeBytes(node.secret_key()));
      measureConnect(connectStart);
      return node;
    })().catch((error) => {
      endpointPromise = undefined;
      throw error;
    });
  }
  const node = await endpointPromise;
  // A pending spawn may write its key to session storage; fold it in.
  adoptDurableIrohDeviceKey();
  return node;
}

/** Warm the WASM endpoint at idle (#659). The gate stays narrow: a 2 MB
 * download cached by `public/sw.js`, and a paired page can still route
 * elsewhere (`window.CentraidIroh` is a replaceable seam). */
export function warmIrohTransport(): void {
  if (endpointPromise) return;
  if (!webGatewayId(loadConnection())) return;
  // Identity check: warm only the transport we installed.
  if (window.CentraidIroh?.fetch !== irohFetch) return;
  const warm = (): void => {
    void endpoint().catch(() => {
      // A warm failure is silent; the first real request reports.
    });
  };
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
}

/** MOVE, never copy: this key IS the enrolled identity, and in sessionStorage
 * it silently unpairs on restart. Durability is not a consent axis. */
export function adoptDurableIrohDeviceKey(): string | null {
  const stored =
    localStorage.getItem(KEY_STORAGE) ?? sessionStorage.getItem(KEY_STORAGE);
  if (stored !== null) localStorage.setItem(KEY_STORAGE, stored);
  sessionStorage.removeItem(KEY_STORAGE);
  return stored;
}

export interface IrohPairingInput {
  endpointTicket: string;
  ticketId: string;
  secret: string;
  deviceName: string;
  rememberDevice: boolean;
}

export interface IrohPairingResponse {
  ok: boolean;
  error?: string;
  gatewayId?: string;
  gatewayName?: string;
  vaultId?: string;
  vaultName?: string;
  vaultIds?: string[];
  vaults?: Array<{
    vaultId: string;
    enrollmentId?: string;
    vaultName?: string;
  }>;
  version?: string;
}

export async function pairGatewayOverIroh(
  input: IrohPairingInput
): Promise<{ response: IrohPairingResponse; endpointId: string }> {
  const node = await endpoint();
  const response = JSON.parse(
    await node.pair_gateway(
      input.endpointTicket,
      JSON.stringify({
        ticketId: input.ticketId,
        secret: input.secret,
        deviceName: input.deviceName,
        platform: "web",
        rememberDevice: input.rememberDevice,
      })
    )
  ) as IrohPairingResponse;
  return { response, endpointId: node.endpoint_id() };
}

// The only failure provably raised BEFORE the body went out.
function isConnectFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(connect_failure_marker());
}

function jitteredBackoff(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withConnectTimeout(
  pending: Promise<BrowserResponse>
): Promise<BrowserResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Iroh gateway connect timed out.")),
      CONNECT_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// A rejection means no bytes reached the caller, so a retry duplicates nothing;
// a non-idempotent request replays only on a proven connect failure.
async function requestWithRetry(
  node: BrowserEndpoint,
  endpointTicket: string,
  method: string,
  target: string,
  headersJson: string,
  body: Uint8Array
): Promise<BrowserResponse> {
  const idempotent = IDEMPOTENT_METHODS.has(method);
  const attemptRequest = async (attempt: number): Promise<BrowserResponse> => {
    irohStats().streams += 1;
    const requestStart = nowMs();
    try {
      const response = await withConnectTimeout(
        node.request(endpointTicket, method, target, headersJson, body)
      );
      measureRequest(requestStart);
      return response;
    } catch (error) {
      const retryable = idempotent || isConnectFailure(error);
      if (attempt >= MAX_RETRIES || !retryable) throw error;
      irohStats().reconnects += 1;
      await sleep(jitteredBackoff(RETRY_BACKOFF_MS[attempt] ?? 750));
      return attemptRequest(attempt + 1);
    }
  };
  return attemptRequest(0);
}

function responseHeaders(raw: string): Headers {
  const headers = new Headers();
  const values = JSON.parse(raw) as Record<string, string | string[]>;
  for (const [name, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function requestParts(init: RequestInit): Promise<{
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}> {
  const method = (init.method ?? "GET").toUpperCase();
  const request = new Request(window.location.href, {
    ...init,
    method,
    ...(method === "GET" || method === "HEAD" ? { body: undefined } : {}),
  });
  const headers = Object.fromEntries(request.headers.entries());
  // The transport bypasses browser HTTP; stamp the shell origin explicitly.
  headers["origin"] = window.location.origin;
  // Browsers never expose Accept-Encoding to JS; without this the gateway ships
  // raw bytes. `irohFetch` decodes.
  if (!(headers["accept"] || "").toLowerCase().includes("text/event-stream")) {
    headers["accept-encoding"] = "gzip";
  }
  const body =
    method === "GET" || method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
  return { method, headers, body };
}

export async function irohFetch(
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  const connection = loadConnection();
  if (!connection.endpointId || !connection.endpointTicket) {
    throw new Error("No Iroh gateway is connected.");
  }
  const node = await endpoint();
  const parts = await requestParts(init);
  const response: BrowserResponse = await requestWithRetry(
    node,
    connection.endpointTicket,
    parts.method,
    pathname,
    JSON.stringify(parts.headers),
    parts.body
  );
  const headers = responseHeaders(response.headers_json);
  let body: ReadableStream = response.take_body();
  // A JS-built Response is not auto-decoded; strip the compressed-form headers
  // but KEEP the ETag, keyed to raw bytes.
  if ((headers.get("content-encoding") || "").toLowerCase() === "gzip") {
    headers.delete("content-encoding");
    headers.delete("content-length");
    body = body.pipeThrough(new DecompressionStream("gzip"));
  }
  return new Response(body, { status: response.status, headers });
}

async function bridgeFetch(message: BridgeRequest): Promise<BrowserResponse> {
  const connection = loadConnection();
  if (!connection.endpointId || !connection.endpointTicket) {
    throw new Error("No Iroh gateway is connected.");
  }
  const headers: Record<string, string> = {
    ...message.headers,
    "x-centraid-tunnel-auth-mode": "web-session",
  };
  // Set unconditionally: the desktop tunnel keys off it to STRIP the device
  // bearer, so behind the cookie check an idle app falls through to the full
  // bearer.
  if (message.sessionCookie) {
    headers["cookie"] = message.sessionCookie;
  }
  return requestWithRetry(
    await endpoint(),
    connection.endpointTicket,
    message.method,
    message.target,
    JSON.stringify(headers),
    new Uint8Array(message.body)
  );
}

function bridgeId(): string {
  const connection = loadConnection();
  const durable = connection.rememberDevice === true;
  const storage = durable ? localStorage : sessionStorage;
  const stale = durable ? sessionStorage : localStorage;
  // Tickets refresh without changing the gateway; keep the cache namespace.
  const scope = `${webGatewayId(connection) ?? connection.endpointTicket ?? ""}\u0000${connection.vaultId ?? ""}`;
  let saved: { scope?: string; id?: string } = {};
  try {
    saved = JSON.parse(storage.getItem(BRIDGE_STORAGE) ?? "{}") as typeof saved;
  } catch {
    saved = {};
  }
  const prefix = durable ? "d-" : "e-";
  const id =
    saved.scope === scope && saved.id?.startsWith(prefix)
      ? saved.id
      : irohBridgeIdForConsent(durable);
  if (saved.scope !== scope || saved.id !== id) {
    saved = { scope, id };
    storage.setItem(BRIDGE_STORAGE, JSON.stringify(saved));
    stale.removeItem(BRIDGE_STORAGE);
  }
  return id;
}

/** Only `d-` bridge scopes are cache-readable to the worker. */
export function irohBridgeIdForConsent(
  rememberDevice: boolean,
  randomId = crypto.randomUUID()
): string {
  return `${rememberDevice ? "d" : "e"}-${randomId}`;
}

export function purgeIrohDeviceState(): void {
  const current = endpointPromise;
  endpointPromise = undefined;
  const clear = (): void => {
    for (const storage of [localStorage, sessionStorage]) {
      storage.removeItem(KEY_STORAGE);
      storage.removeItem(BRIDGE_STORAGE);
    }
  };
  clear();
  void syncIrohWakeConfiguration();
  void current
    ?.then(async (node) => {
      await node.close().catch(() => undefined);
      // A pending spawn can write its key after the clear.
      clear();
    })
    .catch(() => undefined);
}

interface IrohWakeConfiguration {
  deviceKey: string;
  endpointTicket: string;
  vaultId: string;
}

function currentIrohWakeConfiguration(): IrohWakeConfiguration | undefined {
  const connection = loadConnection();
  const deviceKey = adoptDurableIrohDeviceKey();
  if (!deviceKey || !connection.endpointTicket || !connection.vaultId)
    return undefined;
  return {
    deviceKey,
    endpointTicket: connection.endpointTicket,
    vaultId: connection.vaultId,
  };
}

/** A closed PWA has no WindowClient, so the worker authenticates its own pull. */
export async function syncIrohWakeConfiguration(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active ?? navigator.serviceWorker.controller;
  const message = {
    type: "centraid:configure-iroh-wake",
    configuration: currentIrohWakeConfiguration(),
  };
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker has no targetOrigin argument (#647)
  worker?.postMessage(message);
}

function isIrohWorker(worker: ServiceWorker | null): boolean {
  return worker?.scriptURL.includes(`v=${SERVICE_WORKER_VERSION}`) ?? false;
}

export async function ensureIrohServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator))
    throw new Error("This browser does not support PWA workers.");
  const registration =
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await registration.update();
  await navigator.serviceWorker.ready;
  if (isIrohWorker(navigator.serviceWorker.controller)) {
    await syncIrohWakeConfiguration();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("Iroh PWA worker did not activate.")),
      5000
    );
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        if (isIrohWorker(navigator.serviceWorker.controller)) {
          window.clearTimeout(timeout);
          resolve();
        }
      },
      { once: true }
    );
  });
  await syncIrohWakeConfiguration();
}

export async function irohVirtualUrl(target: string): Promise<string> {
  await ensureIrohServiceWorker();
  const path = target.startsWith("/") ? target : `/${target}`;
  return new URL(
    `${VIRTUAL_PREFIX}${bridgeId()}${path}`,
    window.location.origin
  ).toString();
}

interface BridgeRequest {
  type: "centraid:iroh-request" | "centraid:iroh-claim";
  bridgeId: string;
  target: string;
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  sessionCookie?: string;
}

function postError(port: MessagePort, error: unknown): void {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

export function installIrohServiceWorkerBridge(): void {
  // Surface the perf counters at boot (#404): a probe can spot a stale bundle.
  irohStats();
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener(
    "message",
    (event: MessageEvent<BridgeRequest>) => {
      const message = event.data;
      const port = event.ports[0];
      if (!port || message?.bridgeId !== bridgeId()) return;
      if (message.type === "centraid:iroh-claim") {
        port.postMessage({ type: "claim" });
        return;
      }
      if (message.type !== "centraid:iroh-request") return;
      void (async () => {
        const response = await bridgeFetch(message);
        port.postMessage({
          type: "head",
          status: response.status,
          headers: JSON.parse(response.headers_json) as Record<
            string,
            string | string[]
          >,
        });
        const reader = response.take_body().getReader();
        // Ordered stream: post this chunk before reading the next.
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) return;
          const bytes = value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength
          );
          port.postMessage({ type: "chunk", body: bytes }, [bytes]);
          return pump();
        };
        await pump();
        port.postMessage({ type: "end" });
      })().catch((error: unknown) => postError(port, error));
    }
  );
}
