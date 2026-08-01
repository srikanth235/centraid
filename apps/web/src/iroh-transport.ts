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
// A versioned script URL prevents an older shell worker from being treated as
// ready merely because it controls the page. The virtual Iroh route only
// exists in this worker generation. VERSION is shared with public/sw.js and
// its derived Iroh worker binding via sw-version.ts (issue #468 K8).
const SERVICE_WORKER_URL = `/sw.js?v=${SERVICE_WORKER_VERSION}`;

// Transient tunnel failures (a redialed-then-still-dead connection, a stream
// reset) are retried a bounded number of times with jittered backoff. The
// pooled connection in the WASM layer already redials once on a stale cache,
// so a failure that reaches here is worth a short pause before retrying.
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [250, 750];
// A dead radio must fail fast instead of hanging forever. request() resolves
// as soon as the response HEADER is read, so this bounds connect + send +
// first-header, not the (possibly long-lived) body stream.
const CONNECT_TIMEOUT_MS = 15_000;
// Replaying these methods cannot duplicate a side effect.
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
  // A spawn that was still pending may have written its key to the session
  // bucket under the pre-#603 code path; fold it back in.
  adoptDurableIrohDeviceKey();
  return node;
}

/**
 * Bring the WASM endpoint up during idle time, ahead of the first request that
 * needs it (issue #659 C3).
 *
 * This is a 2 MB download, so the gate is deliberately narrow and was set by
 * measurement, not intuition. An earlier version gated only on "already
 * paired" and cost a returning visit the full 2 MB on EVERY visit
 * (perf-waterfall warm shell 0 B -> 1,995,918 B). Two things fixed that:
 *
 *  1. `public/sw.js` now serves JS-initiated `/assets/` fetches through the
 *     shell cache, so the binary is downloaded once per build rather than once
 *     per visit. Without that, warming can only ever move the cost around.
 *  2. The gate below also requires that this page will actually ROUTE through
 *     this transport. A page can be paired to an iroh endpoint and still send
 *     its traffic somewhere else — `window.CentraidIroh` is a replaceable seam,
 *     and the e2e harness replaces it with a direct-HTTP control transport.
 *     Warming a transport nothing will dial is pure waste, and it is the same
 *     waste whether the replacement came from a harness or a host.
 *
 * Still lazy in every other respect: `endpoint()` owns the single-flight
 * promise, and a failed warm just leaves the next real caller to surface it.
 */
export function warmIrohTransport(): void {
  if (endpointPromise) return;
  if (!webGatewayId(loadConnection())) return;
  // Identity check, not a feature check: only warm the transport we installed.
  if (window.CentraidIroh?.fetch !== irohFetch) return;
  const warm = (): void => {
    void endpoint().catch(() => {
      // The first real request re-attempts and reports; a failed warm is not
      // an event the reader should hear about.
    });
  };
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
}

/**
 * Move (never copy) the stable browser device key into durable storage.
 *
 * This key IS the enrolled device identity — losing it means the gateway no
 * longer recognises this browser and the only way back is a fresh pairing
 * ticket. It used to live in sessionStorage whenever "Remember this device"
 * was unchecked (the default), so every browser restart silently unpaired.
 * Durability is no longer a consent axis; the offline copy still is.
 */
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
  version?: string;
  schemaEpoch?: number;
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

// The WASM connect path stamps this context onto a dial failure, which is the
// only failure we can prove happened BEFORE the request body went on the wire.
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

// Wraps node.request() with a connect timeout and bounded, jittered retries.
// A rejection here means the BrowserResponse header never resolved, so NO
// response bytes have reached the caller yet — retrying cannot duplicate
// delivered output. We still refuse to replay a non-idempotent request whose
// body may already be on the wire: only a clear pre-send connect failure is
// retried for those.
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
    // Each node.request() opens one QUIC stream on the pooled endpoint; count
    // it (retries included) so a probe can prove streams ≫ connects.
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
  // The transport bypasses browser HTTP, so stamp the trusted shell origin
  // explicitly for gateway-minted browser app sessions.
  headers["origin"] = window.location.origin;
  // Browsers never expose Accept-Encoding to JS, so advertise gzip explicitly
  // — otherwise the gateway ships raw bytes. irohFetch decodes the reply. Skip
  // SSE (the server exempts text/event-stream anyway; keep the request honest).
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
  // The browser does not auto-decode Content-Encoding on a Response we build in
  // JS from tunnel bytes, so decode gzip here. Strip content-encoding +
  // content-length (they describe the compressed form); ETag is kept — the
  // gateway keys it to the RAW bytes, so revalidation stays correct. gzip only:
  // DecompressionStream has no brotli, and requestParts only offers gzip.
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
  // Every request on this path originates from a generated app in the SW
  // bridge, so the auth mode is fixed by PROVENANCE, not by whether a cookie
  // happens to be in memory. The marker must be set unconditionally: the
  // desktop tunnel keys off it to STRIP the device bearer. Gating it on the
  // cookie (which the browser wipes when it kills an idle service worker)
  // would let an idle app's requests fall through to the full device bearer —
  // a privilege escalation. No cookie means the gateway rejects with 401,
  // never an escalation. Do not "optimize" this back behind the cookie check.
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
  // Relay-bearing endpoint tickets can be refreshed without changing the
  // sovereign gateway. Keep the cache namespace warm across those re-dials.
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

/** The service worker treats only `d-` bridge scopes as cache-readable/writable. */
export function irohBridgeIdForConsent(
  rememberDevice: boolean,
  randomId = crypto.randomUUID()
): string {
  return `${rememberDevice ? "d" : "e"}-${randomId}`;
}

/** Wipe all device-key/bridge state after unpair or remote revocation. */
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
      // A pending spawn can write its key after the eager clear.
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

/**
 * Mirror the minimum paired transport state into private service-worker
 * storage. A closed PWA has no WindowClient to own the normal Iroh bridge, so
 * the worker must be able to authenticate its canonical Notifications pull itself.
 */
export async function syncIrohWakeConfiguration(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active ?? navigator.serviceWorker.controller;
  // ServiceWorker.postMessage's second argument is a transfer list, not a
  // target origin; the generic browser rule does not model this overload.
  const message = {
    type: "centraid:configure-iroh-wake",
    configuration: currentIrohWakeConfiguration(),
  };
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker has no targetOrigin argument (#647)
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
  // Eagerly surface the perf counters (issue #404) the moment the shell boots,
  // so a probe can tell an instrumented bundle apart from a stale one before
  // any request has run. Creating the object changes no transport behavior.
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
        // A MessagePort is an ordered byte stream: do not read the next chunk
        // until the current one has been posted to the service worker.
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
