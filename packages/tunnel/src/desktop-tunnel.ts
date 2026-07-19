/*
 * Desktop side of the phone tunnel (issue #263).
 *
 * Binds one iroh endpoint with two ALPNs:
 *  - `centraid/tunnel/1`: connections are admitted only when the remote
 *    EndpointId is in the device allowlist; every bi-stream is one HTTP
 *    request, forwarded to the loopback gateway with the bearer attached.
 *    The gateway keeps binding 127.0.0.1 and needs zero HTTP changes.
 *  - `centraid/pair/1`: any endpoint may connect, but must present the
 *    one-time pairing code from the "Connect phone" QR; success stores the
 *    phone's EndpointId in the allowlist.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { DeviceStore, PairedDevice } from './device-store.js';
import type { Accepting, Connection, Endpoint, RecvStream, SendStream } from './iroh.js';
import { iroh } from './iroh.js';
import type {
  PairQrPayload,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from './protocol.js';
import {
  alpnBytes,
  CLOSE_UNAUTHORIZED,
  encodeHeaderFrame,
  PAIR_ALPN,
  readBodyToEnd,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_ALPN,
} from './protocol.js';

export interface TunnelUpstream {
  /** Loopback gateway base, e.g. `http://127.0.0.1:18789`. */
  baseUrl: string;
  /** Gateway bearer; attached to every forwarded request. */
  token: string;
}

export interface DesktopTunnelOptions {
  /** 32-byte endpoint secret; omit to generate a fresh identity. */
  secretKey?: Uint8Array;
  /** Resolved per request so the tunnel follows gateway restarts/switches. */
  upstream: () => TunnelUpstream | undefined | Promise<TunnelUpstream | undefined>;
  deviceStore: DeviceStore;
  /** Shown to the phone on successful pairing. */
  desktopName?: string;
  /** `disabled` keeps tests offline; production uses the n0 relays + discovery. */
  relays?: 'n0' | 'disabled';
  onPaired?: (device: PairedDevice) => void;
}

export interface ActivePairing {
  code: string;
  expiresAt: number;
  /** JSON for the QR code: `{v, kind, ticket, code}`. */
  qrPayload: string;
}

export interface DesktopTunnelHandle {
  /** This desktop's stable transport identity (base32 EndpointId). */
  endpointId: string;
  /** Current dial ticket (recomputed — the addr can change with the network). */
  ticket(): string;
  /** Mint (or replace) the one-time pairing code and QR payload. */
  beginPairing(ttlMs?: number): ActivePairing;
  activePairing(): ActivePairing | undefined;
  cancelPairing(): void;
  /** Remove a device from the allowlist and drop its live connections. */
  revokeDevice(deviceId: string): PairedDevice | undefined;
  close(): Promise<void>;
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function startDesktopTunnel(
  options: DesktopTunnelOptions,
): Promise<DesktopTunnelHandle> {
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === 'disabled') builder.relayMode(iroh.RelayMode.disabled());
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  builder.alpns([alpnBytes(TUNNEL_ALPN), alpnBytes(PAIR_ALPN)]);
  const endpoint = await builder.bind();

  const tunnel = new DesktopTunnel(endpoint, options);
  tunnel.runAcceptLoop();
  return tunnel.handle();
}

/** Prefer the Rust byte pump, but keep phone linking available on any target
 * supported by the upstream iroh binding when our own addon is unavailable. */
export async function startPreferredDesktopTunnel(
  options: DesktopTunnelOptions,
): Promise<DesktopTunnelHandle> {
  if (options.secretKey) {
    try {
      const { startNativeDesktopTunnel } = await import('./native-relay.js');
      return await startNativeDesktopTunnel(options);
    } catch {
      // Fall through to the portable relay below.
    }
  }
  return startDesktopTunnel(options);
}

class DesktopTunnel {
  private pairing: ActivePairing | undefined;
  private closed = false;
  private readonly liveConnections = new Map<
    number,
    { connection: Connection; endpointId: string }
  >();

  constructor(
    private readonly endpoint: Endpoint,
    private readonly options: DesktopTunnelOptions,
  ) {}

  handle(): DesktopTunnelHandle {
    return {
      endpointId: this.endpoint.id().toString(),
      ticket: () => iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
      beginPairing: (ttlMs = DEFAULT_PAIRING_TTL_MS) => this.beginPairing(ttlMs),
      activePairing: () => this.currentPairing(),
      cancelPairing: () => {
        this.pairing = undefined;
      },
      revokeDevice: (deviceId) => this.revokeDevice(deviceId),
      close: async () => {
        this.closed = true;
        await this.endpoint.close();
      },
    };
  }

  runAcceptLoop(): void {
    void (async () => {
      for (;;) {
        let incoming;
        try {
          incoming = await this.endpoint.acceptNext();
        } catch {
          if (this.closed || this.endpoint.isClosed()) return;
          continue;
        }
        if (!incoming) return;
        void incoming
          .accept()
          .then((accepting) => this.routeConnection(accepting))
          .catch(() => {
            // Handshake failures are the remote's problem; keep accepting.
          });
      }
    })();
  }

  private async routeConnection(accepting: Accepting): Promise<void> {
    const alpn = Buffer.from(await accepting.alpn()).toString('utf8');
    const connection = await accepting.connect();
    if (alpn === PAIR_ALPN) {
      await this.handlePairConnection(connection);
      return;
    }
    await this.handleTunnelConnection(connection);
  }

  // ---- pairing ----

  private beginPairing(ttlMs: number): ActivePairing {
    const code = crypto.randomBytes(16).toString('base64url');
    const payload: PairQrPayload = {
      v: 1,
      kind: 'centraid-pair',
      ticket: iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
      code,
    };
    this.pairing = { code, expiresAt: Date.now() + ttlMs, qrPayload: JSON.stringify(payload) };
    return { ...this.pairing };
  }

  private currentPairing(): ActivePairing | undefined {
    if (!this.pairing) return undefined;
    if (Date.now() > this.pairing.expiresAt) {
      this.pairing = undefined;
      return undefined;
    }
    return { ...this.pairing };
  }

  private async handlePairConnection(connection: Connection): Promise<void> {
    try {
      const bi = await connection.acceptBi();
      const request = await readHeaderFrame<PairRequest>(bi.recv);
      const response = this.evaluatePairRequest(connection, request);
      await bi.send.writeAll(encodeHeaderFrame(response));
      await bi.send.finish();
    } catch {
      // Malformed pairing attempt; drop it.
    } finally {
      setTimeout(() => connection.close(0n, []), 1000);
    }
  }

  private evaluatePairRequest(connection: Connection, request: PairRequest): PairResponse {
    if (typeof request?.code !== 'string' || typeof request?.deviceName !== 'string') {
      return { ok: false, error: 'bad_request' };
    }
    const pairing = this.pairing;
    if (!pairing || !timingSafeEqualStr(pairing.code, request.code)) {
      return { ok: false, error: 'invalid_code' };
    }
    if (Date.now() > pairing.expiresAt) {
      this.pairing = undefined;
      return { ok: false, error: 'expired_code' };
    }
    this.pairing = undefined; // one-time: consumed on success
    const device = this.options.deviceStore.add({
      name: request.deviceName,
      platform: typeof request.platform === 'string' ? request.platform : 'unknown',
      endpointId: connection.remoteId().toString(),
    });
    this.options.onPaired?.(device);
    return {
      ok: true,
      deviceId: device.deviceId,
      desktopName: this.options.desktopName ?? 'Centraid Desktop',
    };
  }

  // ---- HTTP forwarding ----

  private revokeDevice(deviceId: string): PairedDevice | undefined {
    const removed = this.options.deviceStore.remove(deviceId);
    if (!removed) return undefined;
    for (const [stableId, live] of this.liveConnections) {
      if (live.endpointId === removed.endpointId) {
        live.connection.close(CLOSE_UNAUTHORIZED, alpnBytes('revoked'));
        this.liveConnections.delete(stableId);
      }
    }
    return removed;
  }

  private async handleTunnelConnection(connection: Connection): Promise<void> {
    const endpointId = connection.remoteId().toString();
    if (!this.options.deviceStore.findByEndpointId(endpointId)) {
      connection.close(CLOSE_UNAUTHORIZED, alpnBytes('unauthorized'));
      return;
    }
    const stableId = connection.stableId();
    this.liveConnections.set(stableId, { connection, endpointId });
    try {
      for (;;) {
        const bi = await connection.acceptBi();
        // Revocation guard: the allowlist is consulted per stream, so a
        // revoked device loses access even on a connection that predates it.
        if (!this.options.deviceStore.findByEndpointId(endpointId)) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes('revoked'));
          return;
        }
        void this.serveStream(bi.send, bi.recv).catch(() => {
          // Per-request failures already answered with a 502 frame when possible.
        });
      }
    } catch {
      // Connection closed (by peer, revocation, or shutdown).
    } finally {
      this.liveConnections.delete(stableId);
    }
  }

  private async serveStream(send: SendStream, recv: RecvStream): Promise<void> {
    let header: TunnelRequestHeader;
    let body: Buffer;
    try {
      header = await readHeaderFrame<TunnelRequestHeader>(recv);
      body = await readBodyToEnd(recv);
    } catch {
      await this.respondError(send, 400, 'bad_request');
      return;
    }
    const upstream = await Promise.resolve(this.options.upstream()).catch(() => undefined);
    if (!upstream) {
      await this.respondError(send, 503, 'gateway_unavailable');
      return;
    }
    if (typeof header.target !== 'string' || !header.target.startsWith('/')) {
      await this.respondError(send, 400, 'bad_target');
      return;
    }
    const base = new URL(upstream.baseUrl);
    const headers = sanitizeHeaders(header.headers ?? {});
    headers.host = base.host;
    headers.authorization = `Bearer ${upstream.token}`;
    if (body.length > 0) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    await new Promise<void>((resolve) => {
      const request = http.request(
        {
          host: base.hostname,
          port: base.port,
          method: header.method,
          path: header.target,
          headers,
        },
        (response) => {
          void (async () => {
            const responseHeader: TunnelResponseHeader = {
              status: response.statusCode ?? 502,
              headers: sanitizeHeaders(response.headers as Record<string, string | string[]>),
            };
            await send.writeAll(encodeHeaderFrame(responseHeader));
            // Sequential for-await keeps chunk ordering; SSE stays live
            // because each chunk is written the moment it arrives.
            for await (const chunk of response) {
              await send.writeAll(Array.from(chunk as Buffer));
            }
            await send.finish();
          })()
            .catch(async () => {
              await send.reset(1n).catch(() => undefined);
            })
            .finally(resolve);
        },
      );
      request.on('error', () => {
        void this.respondError(send, 502, 'upstream_unreachable').finally(resolve);
      });
      request.end(body);
    });
  }

  private async respondError(send: SendStream, status: number, error: string): Promise<void> {
    try {
      const body = Buffer.from(JSON.stringify({ error }), 'utf8');
      await send.writeAll(
        encodeHeaderFrame({
          status,
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        } satisfies TunnelResponseHeader),
      );
      await send.writeAll(Array.from(body));
      await send.finish();
    } catch {
      // Stream already gone.
    }
  }
}
