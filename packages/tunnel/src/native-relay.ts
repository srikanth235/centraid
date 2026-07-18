import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { GatewayEndpointHandle } from './gateway-endpoint.js';
import type { ActivePairing, DesktopTunnelHandle, DesktopTunnelOptions } from './desktop-tunnel.js';
import type { PairQrPayload, PairRequest, PairResponse } from './protocol.js';

interface NativeRelay {
  readonly endpointId: string;
  ticket(): string;
  close(): Promise<void>;
  revokeEndpoint(endpointId: string): Promise<void>;
}

interface NativeBinding {
  startGatewayRelay(options: {
    secretKeyHex: string;
    upstreamUrl: string;
    upstreamToken: string;
    controlSecret: string;
    useN0Relays: boolean;
  }): Promise<NativeRelay>;
  startDesktopRelay(options: {
    secretKeyHex: string;
    controlUrl: string;
    controlSecret: string;
    useN0Relays: boolean;
  }): Promise<NativeRelay>;
}

let binding: NativeBinding | undefined;

function loadBinding(): NativeBinding {
  if (binding) return binding;
  const artifact = new URL(
    `../native/centraid-tunnel-native.${process.platform}-${process.arch}.node`,
    import.meta.url,
  );
  binding = createRequire(import.meta.url)(fileURLToPath(artifact)) as NativeBinding;
  return binding;
}

export async function startNativeGatewayRelay(options: {
  secretKey: Uint8Array;
  upstream: { baseUrl: string; token: string };
  controlSecret: string;
  relays?: 'n0' | 'disabled';
}): Promise<GatewayEndpointHandle> {
  const relay = await loadBinding().startGatewayRelay({
    secretKeyHex: Buffer.from(options.secretKey).toString('hex'),
    upstreamUrl: options.upstream.baseUrl,
    upstreamToken: options.upstream.token,
    controlSecret: options.controlSecret,
    useN0Relays: options.relays !== 'disabled',
  });
  return {
    endpointId: relay.endpointId,
    ticket: () => relay.ticket(),
    revokeEndpoint: (endpointId) => relay.revokeEndpoint(endpointId),
    close: () => relay.close(),
  };
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readControlJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_CONTROL_BODY_BYTES) throw new Error('native tunnel control body is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendControlJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

/**
 * Production desktop endpoint. JavaScript owns only the allowlist, pairing
 * state, and dynamic loopback coordinates exposed through an authenticated
 * metadata server. Rust owns iroh, every request body, upstream I/O, and
 * every response byte (#456 N2).
 */
export async function startNativeDesktopTunnel(
  options: DesktopTunnelOptions,
): Promise<DesktopTunnelHandle> {
  if (!options.secretKey || options.secretKey.length !== 32) {
    throw new Error('native desktop tunnel requires a persistent 32-byte secret key');
  }
  const controlSecret = crypto.randomBytes(32).toString('hex');
  let pairing: ActivePairing | undefined;
  let relay: NativeRelay | undefined;

  const currentPairing = (): ActivePairing | undefined => {
    if (!pairing) return undefined;
    if (Date.now() > pairing.expiresAt) {
      pairing = undefined;
      return undefined;
    }
    return { ...pairing };
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (
        !timingSafeEqualText(
          String(req.headers['x-centraid-data-plane-secret'] ?? ''),
          controlSecret,
        )
      ) {
        sendControlJson(res, 403, { error: 'forbidden' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://native-tunnel.local');
      const endpointId = url.searchParams.get('endpointId') ?? '';
      if (url.pathname.endsWith('/authorize') && req.method === 'GET') {
        const allowed = Boolean(endpointId && options.deviceStore.findByEndpointId(endpointId));
        const upstream = allowed
          ? await Promise.resolve(options.upstream()).catch(() => undefined)
          : undefined;
        sendControlJson(res, 200, {
          allowed,
          ...(upstream ? { upstreamUrl: upstream.baseUrl, upstreamToken: upstream.token } : {}),
        });
        return;
      }
      if (url.pathname.endsWith('/pair') && req.method === 'POST') {
        const request = (await readControlJson(req)) as unknown as PairRequest;
        let response: PairResponse;
        if (
          !endpointId ||
          typeof request?.code !== 'string' ||
          typeof request?.deviceName !== 'string'
        ) {
          response = { ok: false, error: 'bad_request' };
        } else if (!pairing || !timingSafeEqualText(pairing.code, request.code)) {
          response = { ok: false, error: 'invalid_code' };
        } else if (Date.now() > pairing.expiresAt) {
          pairing = undefined;
          response = { ok: false, error: 'expired_code' };
        } else {
          pairing = undefined;
          const device = options.deviceStore.add({
            name: request.deviceName,
            platform: typeof request.platform === 'string' ? request.platform : 'unknown',
            endpointId,
          });
          options.onPaired?.(device);
          response = {
            ok: true,
            deviceId: device.deviceId,
            desktopName: options.desktopName ?? 'Centraid Desktop',
          };
        }
        sendControlJson(res, 200, response);
        return;
      }
      sendControlJson(res, 404, { error: 'not_found' });
    })().catch((error) => sendControlJson(res, 400, { error: String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay = await loadBinding().startDesktopRelay({
      secretKeyHex: Buffer.from(options.secretKey).toString('hex'),
      controlUrl,
      controlSecret,
      useN0Relays: options.relays !== 'disabled',
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    endpointId: relay.endpointId,
    ticket: () => relay!.ticket(),
    beginPairing: (ttlMs = DEFAULT_PAIRING_TTL_MS) => {
      const code = crypto.randomBytes(16).toString('base64url');
      const payload: PairQrPayload = {
        v: 1,
        kind: 'centraid-pair',
        ticket: relay!.ticket(),
        code,
      };
      pairing = { code, expiresAt: Date.now() + ttlMs, qrPayload: JSON.stringify(payload) };
      return { ...pairing };
    },
    activePairing: currentPairing,
    cancelPairing: () => {
      pairing = undefined;
    },
    revokeDevice: (deviceId) => {
      const removed = options.deviceStore.remove(deviceId);
      if (removed) void relay!.revokeEndpoint(removed.endpointId).catch(() => undefined);
      return removed;
    },
    close: async () => {
      await relay!.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
