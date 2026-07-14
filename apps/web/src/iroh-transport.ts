import initWasm, { BrowserEndpoint, type BrowserResponse } from './generated/centraid_web_iroh.js';
import { loadConnection } from './web-state.js';

const KEY_STORAGE = 'centraid.web.v1.iroh-device-key';
const BRIDGE_STORAGE = 'centraid.web.v1.iroh-bridge';
const VIRTUAL_PREFIX = '/__centraid_iroh__/';
// A versioned script URL prevents an older shell worker from being treated as
// ready merely because it controls the page. The virtual Iroh route only
// exists in this worker generation.
const SERVICE_WORKER_VERSION = 'iroh-bridge-v5';
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

function decodeBytes(raw: string): Uint8Array {
  return Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function endpoint(): Promise<BrowserEndpoint> {
  if (!endpointPromise) {
    endpointPromise = (async () => {
      await initWasm();
      const stored = localStorage.getItem(KEY_STORAGE);
      const node = await BrowserEndpoint.spawn(stored ? decodeBytes(stored) : undefined);
      if (!stored) localStorage.setItem(KEY_STORAGE, encodeBytes(node.secret_key()));
      return node;
    })().catch((error) => {
      endpointPromise = undefined;
      throw error;
    });
  }
  return endpointPromise;
}

export interface IrohPairingInput {
  endpointTicket: string;
  ticketId: string;
  secret: string;
  deviceName: string;
}

export interface IrohPairingResponse {
  ok: boolean;
  error?: string;
  gatewayName?: string;
  vaultId?: string;
  vaultName?: string;
  version?: string;
  schemaEpoch?: number;
}

export async function pairGatewayOverIroh(
  input: IrohPairingInput,
): Promise<{ response: IrohPairingResponse; endpointId: string }> {
  const node = await endpoint();
  const response = JSON.parse(
    await node.pair_gateway(
      input.endpointTicket,
      JSON.stringify({
        ticketId: input.ticketId,
        secret: input.secret,
        deviceName: input.deviceName,
        platform: 'web',
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
    timer = setTimeout(() => reject(new Error('Iroh gateway connect timed out.')), CONNECT_TIMEOUT_MS);
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
    try {
      return await withConnectTimeout(
        node.request(endpointTicket, method, target, headersJson, body),
      );
    } catch (error) {
      const retryable = idempotent || isConnectFailure(error);
      if (attempt >= MAX_RETRIES || !retryable) throw error;
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
  let id = sessionStorage.getItem(BRIDGE_STORAGE);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(BRIDGE_STORAGE, id);
  }
  return id;
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
