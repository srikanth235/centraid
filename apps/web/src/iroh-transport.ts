import initWasm, { BrowserEndpoint, type BrowserResponse } from './generated/centraid_web_iroh.js';
import { loadConnection, webGatewayId } from './web-state.js';

const KEY_STORAGE = 'centraid.web.v1.iroh-device-key';
const BRIDGE_STORAGE = 'centraid.web.v1.iroh-bridge';
const VIRTUAL_PREFIX = '/__centraid_iroh__/';
// A versioned script URL prevents an older shell worker from being treated as
// ready merely because it controls the page. The virtual Iroh route only
// exists in this worker generation.
const SERVICE_WORKER_VERSION = 'iroh-bridge-v8';
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
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

let endpointPromise: Promise<BrowserEndpoint> | undefined;

// --- Perf instrumentation (issue #404 workstream I) --------------------------
// Lightweight, guarded probes proving the QUIC connection pool is reused: many
// request STREAMS ride a single endpoint CONNECT. Surfaced two ways so a test
// or a console can observe pool reuse without touching internals:
//   * globalThis.__centraidIrohStats — running counters {connects, streams,
//     reconnects}. After N pooled requests, connects should be ≪ streams.
//   * performance marks/measures — `centraid:iroh-connect` (endpoint spawn) and
//     `centraid:iroh-request` (stream open → first response header/byte), so
//     the User Timing timeline carries per-phase durations.
// These never change transport behavior and never throw (every call is wrapped).
interface IrohStats {
  /** Endpoint spawns — a fresh QUIC endpoint. Memoized, so this stays ~1. */
  connects: number;
  /** node.request() calls — one bidirectional QUIC stream each (retries included). */
  streams: number;
  /** Retry rounds after a transient connect/stream failure. */
  reconnects: number;
}

function irohStats(): IrohStats {
  const holder = globalThis as unknown as { __centraidIrohStats?: IrohStats };
  if (!holder.__centraidIrohStats) {
    holder.__centraidIrohStats = { connects: 0, streams: 0, reconnects: 0 };
  }
  return holder.__centraidIrohStats;
}

function markConnectStart(): number {
  try {
    performance.mark('centraid:iroh-connect-start');
  } catch {
    /* User Timing may be unavailable; instrumentation is best-effort. */
  }
  return nowMs();
}

function measureConnect(startMs: number): void {
  irohStats().connects += 1;
  try {
    performance.mark('centraid:iroh-connect-end');
    performance.measure('centraid:iroh-connect', { start: startMs, end: nowMs() });
  } catch {
    /* best-effort */
  }
}

function measureRequest(startMs: number): void {
  try {
    performance.measure('centraid:iroh-request', { start: startMs, end: nowMs() });
  } catch {
    /* best-effort */
  }
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function decodeBytes(raw: string): Uint8Array {
  return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function endpoint(
  rememberDevice = loadConnection().rememberDevice === true,
): Promise<BrowserEndpoint> {
  const stored = moveIrohDeviceKeyForConsent(rememberDevice);
  // Consent changes move the same key between session/durable storage. Keep
  // the live endpoint as well: rotating it would strand an enrolled identity.
  if (!endpointPromise) {
    endpointPromise = (async () => {
      const connectStart = markConnectStart();
      await initWasm();
      const storage = rememberDevice ? localStorage : sessionStorage;
      const node = await BrowserEndpoint.spawn(stored ? decodeBytes(stored) : undefined);
      if (!stored) storage.setItem(KEY_STORAGE, encodeBytes(node.secret_key()));
      measureConnect(connectStart);
      return node;
    })().catch((error) => {
      endpointPromise = undefined;
      throw error;
    });
  }
  const node = await endpointPromise;
  // Cover a consent toggle while the first WASM spawn was still pending: its
  // closure may have written to the old bucket after the pre-spawn move.
  moveIrohDeviceKeyForConsent(rememberDevice);
  return node;
}

/** Move (never copy) the stable browser device key into its consented bucket. */
export function moveIrohDeviceKeyForConsent(rememberDevice: boolean): string | null {
  const target = rememberDevice ? localStorage : sessionStorage;
  const stale = rememberDevice ? sessionStorage : localStorage;
  const stored = target.getItem(KEY_STORAGE) ?? stale.getItem(KEY_STORAGE);
  if (stored !== null) target.setItem(KEY_STORAGE, stored);
  stale.removeItem(KEY_STORAGE);
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
  input: IrohPairingInput,
): Promise<{ response: IrohPairingResponse; endpointId: string }> {
  const node = await endpoint(input.rememberDevice);
  const response = JSON.parse(
    await node.pair_gateway(
      input.endpointTicket,
      JSON.stringify({
        ticketId: input.ticketId,
        secret: input.secret,
        deviceName: input.deviceName,
        platform: 'web',
        rememberDevice: input.rememberDevice,
      }),
    ),
  ) as IrohPairingResponse;
  return { response, endpointId: node.endpoint_id() };
}

// The WASM connect path stamps this context onto a dial failure, which is the
// only failure we can prove happened BEFORE the request body went on the wire.
function isConnectFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('could not connect to gateway tunnel');
}

function jitteredBackoff(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConnectTimeout(pending: Promise<BrowserResponse>): Promise<BrowserResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Iroh gateway connect timed out.')),
      CONNECT_TIMEOUT_MS,
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
  body: Uint8Array,
): Promise<BrowserResponse> {
  const idempotent = IDEMPOTENT_METHODS.has(method);
  for (let attempt = 0; ; attempt += 1) {
    // Each node.request() opens one QUIC stream on the pooled endpoint; count
    // it (retries included) so a probe can prove streams ≫ connects.
    irohStats().streams += 1;
    const requestStart = nowMs();
    try {
      const response = await withConnectTimeout(
        node.request(endpointTicket, method, target, headersJson, body),
      );
      measureRequest(requestStart);
      return response;
    } catch (error) {
      const retryable = idempotent || isConnectFailure(error);
      if (attempt >= MAX_RETRIES || !retryable) throw error;
      irohStats().reconnects += 1;
      await sleep(jitteredBackoff(RETRY_BACKOFF_MS[attempt] ?? 750));
    }
  }
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
  const method = (init.method ?? 'GET').toUpperCase();
  const request = new Request(window.location.href, {
    ...init,
    method,
    ...(method === 'GET' || method === 'HEAD' ? { body: undefined } : {}),
  });
  const headers = Object.fromEntries(request.headers.entries());
  // The transport bypasses browser HTTP, so stamp the trusted shell origin
  // explicitly for gateway-minted browser app sessions.
  headers['origin'] = window.location.origin;
  // Browsers never expose Accept-Encoding to JS, so advertise gzip explicitly
  // — otherwise the gateway ships raw bytes. irohFetch decodes the reply. Skip
  // SSE (the server exempts text/event-stream anyway; keep the request honest).
  if (!(headers['accept'] || '').toLowerCase().includes('text/event-stream')) {
    headers['accept-encoding'] = 'gzip';
  }
  const body =
    method === 'GET' || method === 'HEAD'
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
  return { method, headers, body };
}

export async function irohFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const connection = loadConnection();
  if (connection.transport !== 'iroh' || !connection.endpointTicket) {
    throw new Error('No Iroh gateway is connected.');
  }
  const node = await endpoint();
  const parts = await requestParts(init);
  const response: BrowserResponse = await requestWithRetry(
    node,
    connection.endpointTicket,
    parts.method,
    pathname,
    JSON.stringify(parts.headers),
    parts.body,
  );
  const headers = responseHeaders(response.headers_json);
  let body: ReadableStream = response.take_body();
  // The browser does not auto-decode Content-Encoding on a Response we build in
  // JS from tunnel bytes, so decode gzip here. Strip content-encoding +
  // content-length (they describe the compressed form); ETag is kept — the
  // gateway keys it to the RAW bytes, so revalidation stays correct. gzip only:
  // DecompressionStream has no brotli, and requestParts only offers gzip.
  if ((headers.get('content-encoding') || '').toLowerCase() === 'gzip') {
    headers.delete('content-encoding');
    headers.delete('content-length');
    body = body.pipeThrough(new DecompressionStream('gzip'));
  }
  return new Response(body, { status: response.status, headers });
}

async function bridgeFetch(message: BridgeRequest): Promise<BrowserResponse> {
  const connection = loadConnection();
  if (connection.transport !== 'iroh' || !connection.endpointTicket) {
    throw new Error('No Iroh gateway is connected.');
  }
  const headers = { ...message.headers };
  // Every request on this path originates from a generated app in the SW
  // bridge, so the auth mode is fixed by PROVENANCE, not by whether a cookie
  // happens to be in memory. The marker must be set unconditionally: the
  // desktop tunnel keys off it to STRIP the device bearer. Gating it on the
  // cookie (which the browser wipes when it kills an idle service worker)
  // would let an idle app's requests fall through to the full device bearer —
  // a privilege escalation. No cookie means the gateway rejects with 401,
  // never an escalation. Do not "optimize" this back behind the cookie check.
  headers['x-centraid-tunnel-auth-mode'] = 'web-session';
  if (message.sessionCookie) {
    headers['cookie'] = message.sessionCookie;
  }
  return requestWithRetry(
    await endpoint(),
    connection.endpointTicket,
    message.method,
    message.target,
    JSON.stringify(headers),
    new Uint8Array(message.body),
  );
}

function bridgeId(): string {
  const connection = loadConnection();
  const durable = connection.rememberDevice === true;
  const storage = durable ? localStorage : sessionStorage;
  const stale = durable ? sessionStorage : localStorage;
  // Relay-bearing endpoint tickets can be refreshed without changing the
  // sovereign gateway. Keep the cache namespace warm across those re-dials.
  const scope = `${webGatewayId(connection) ?? connection.endpointTicket ?? ''}\u0000${connection.vaultId ?? ''}`;
  let saved: { scope?: string; id?: string } = {};
  try {
    saved = JSON.parse(storage.getItem(BRIDGE_STORAGE) ?? '{}') as typeof saved;
  } catch {
    saved = {};
  }
  const prefix = durable ? 'd-' : 'e-';
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
  randomId = crypto.randomUUID(),
): string {
  return `${rememberDevice ? 'd' : 'e'}-${randomId}`;
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
  void current
    ?.then(async (node) => {
      await node.close().catch(() => undefined);
      // A pending spawn can write its key after the eager clear.
      clear();
    })
    .catch(() => undefined);
}

function isIrohWorker(worker: ServiceWorker | null): boolean {
  return worker?.scriptURL.includes(`v=${SERVICE_WORKER_VERSION}`) ?? false;
}

export async function ensureIrohServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator))
    throw new Error('This browser does not support PWA workers.');
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  await registration.update();
  await navigator.serviceWorker.ready;
  if (isIrohWorker(navigator.serviceWorker.controller)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Iroh PWA worker did not activate.')),
      5000,
    );
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        if (isIrohWorker(navigator.serviceWorker.controller)) {
          window.clearTimeout(timeout);
          resolve();
        }
      },
      { once: true },
    );
  });
}

export async function irohVirtualUrl(target: string): Promise<string> {
  await ensureIrohServiceWorker();
  const path = target.startsWith('/') ? target : `/${target}`;
  return new URL(`${VIRTUAL_PREFIX}${bridgeId()}${path}`, window.location.origin).toString();
}

interface BridgeRequest {
  type: 'centraid:iroh-request';
  bridgeId: string;
  target: string;
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  sessionCookie?: string;
}

function postError(port: MessagePort, error: unknown): void {
  port.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
}

export function installIrohServiceWorkerBridge(): void {
  // Eagerly surface the perf counters (issue #404) the moment the shell boots,
  // so a probe can tell an instrumented bundle apart from a stale one before
  // any request has run. Creating the object changes no transport behavior.
  irohStats();
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<BridgeRequest>) => {
    const message = event.data;
    const port = event.ports[0];
    if (!port || message?.type !== 'centraid:iroh-request' || message.bridgeId !== bridgeId())
      return;
    void (async () => {
      const response = await bridgeFetch(message);
      port.postMessage({
        type: 'head',
        status: response.status,
        headers: JSON.parse(response.headers_json) as Record<string, string | string[]>,
      });
      const reader = response.take_body().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        port.postMessage({ type: 'chunk', body: bytes }, [bytes]);
      }
      port.postMessage({ type: 'end' });
    })().catch((error: unknown) => postError(port, error));
  });
}
