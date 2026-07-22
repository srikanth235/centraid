import { appActionPath, appQueryPath } from '@centraid/protocol';
import initWasm, {
  BrowserEndpoint,
  connect_failure_marker,
  device_revoked_marker,
  type BrowserResponse,
} from '../../web/src/generated/centraid_web_iroh.js';
import { loadDeviceKey, loadPairing, purgeCompanionState, saveDeviceKey } from './storage.js';

const CONNECT_TIMEOUT_MS = 15_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
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
      await initWasm(chrome.runtime.getURL('centraid_web_iroh_bg.wasm'));
      const [stored, pairing] = await Promise.all([loadDeviceKey(), loadPairing()]);
      const node = await BrowserEndpoint.spawn(
        stored ? decodeBytes(stored) : undefined,
        pairing?.relayUrls ? [...pairing.relayUrls] : undefined,
      );
      if (!stored) await saveDeviceKey(encodeBytes(node.secret_key()));
      return node;
    })().catch((error) => {
      endpointPromise = undefined;
      throw error;
    });
  }
  return endpointPromise;
}

export async function closeTransport(): Promise<void> {
  const current = endpointPromise;
  endpointPromise = undefined;
  await current?.then((node) => node.close()).catch(() => undefined);
}

export async function pairOverIroh(input: {
  endpointTicket: string;
  ticketId: string;
  secret: string;
  deviceName: string;
  grantProfile: readonly string[];
}): Promise<{ endpointId: string; response: Record<string, unknown> }> {
  const node = await endpoint();
  const raw = await node.pair_gateway(
    input.endpointTicket,
    JSON.stringify({
      ticketId: input.ticketId,
      secret: input.secret,
      deviceName: input.deviceName,
      platform: 'extension',
      rememberDevice: true,
      grantProfile: input.grantProfile,
    }),
  );
  return { endpointId: node.endpoint_id(), response: JSON.parse(raw) as Record<string, unknown> };
}

function isConnectFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(connect_failure_marker());
}

function isDeviceRevoked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(device_revoked_marker());
}

async function requestWithRetry(
  node: BrowserEndpoint,
  ticket: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<BrowserResponse> {
  for (let attempt = 0; ; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Gateway connection timed out.')),
          CONNECT_TIMEOUT_MS,
        );
      });
      return await Promise.race([
        node.request(ticket, method, target, JSON.stringify(headers), body),
        timeout,
      ]);
    } catch (error) {
      if (isDeviceRevoked(error)) throw error;
      if (attempt >= 2 || (!IDEMPOTENT.has(method) && !isConnectFailure(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function companionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const pairing = await loadPairing();
  if (!pairing) throw new Error('Centraid Companion is not paired.');
  const method = (init.method ?? 'GET').toUpperCase();
  const request = new Request('https://centraid.invalid', {
    ...init,
    method,
    ...(method === 'GET' || method === 'HEAD' ? { body: undefined } : {}),
  });
  const headers = Object.fromEntries(request.headers.entries());
  headers['x-centraid-vault'] = pairing.vaultId;
  headers['accept-encoding'] = 'gzip';
  const body =
    method === 'GET' || method === 'HEAD'
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
  const response = await requestWithRetry(
    await endpoint(),
    pairing.endpointTicket,
    method,
    path,
    headers,
    body,
  );
  const responseHeaders = new Headers(JSON.parse(response.headers_json) as Record<string, string>);
  let responseBody = response.take_body();
  if (responseHeaders.get('content-encoding')?.toLowerCase() === 'gzip') {
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseBody = responseBody.pipeThrough(new DecompressionStream('gzip'));
  }
  return new Response(responseBody, { status: response.status, headers: responseHeaders });
}

export async function companionJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await companionFetch(path, init);
  } catch (error) {
    if (!isDeviceRevoked(error)) throw error;
    await closeTransport();
    await purgeCompanionState();
    throw new Error('This device was revoked. Pair it again from Centraid Settings.', {
      cause: error,
    });
  }
  const text = await response.text();
  if (response.status === 401) {
    await closeTransport();
    await purgeCompanionState();
    throw new Error('This device was revoked. Pair it again from Centraid Settings.');
  }
  if (!response.ok) throw new Error(text || `Gateway returned HTTP ${response.status}.`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function appRead<T>(app: string, query: string, input: unknown = {}): Promise<T> {
  return companionJson<T>(appQueryPath(app, query), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
}

export async function appWrite<T>(app: string, action: string, input: unknown): Promise<T> {
  return companionJson<T>(appActionPath(app, action), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, intentId: crypto.randomUUID() }),
  });
}
