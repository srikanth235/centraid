/*
 * Gateway side of the iroh transport (issue #289 phase 3).
 *
 * The gateway daemon binds one iroh endpoint whose EndpointId is the
 * gateway's PERMANENT identity — no domain, no TLS cert, no exposed HTTP
 * port. Two ALPNs:
 *
 *  - `centraid/tunnel/1`: the same HTTP-over-bi-stream protocol the phone
 *    tunnel speaks (see protocol.ts). Connections are admitted only when
 *    the caller's EndpointId passes the injected `authorize` callback (the
 *    gateway's device-enrollment registry); every forwarded request also
 *    carries injected headers naming the calling device, so the gateway's
 *    HTTP layer can resolve the device's vault per request.
 *
 *  - `centraid/gw-pair/1`: ticket redemption. Any endpoint may connect and
 *    present a one-time pairing ticket (id + secret, minted by
 *    `centraid-gateway pair` over SSH); the injected `pair` callback
 *    verifies + burns the ticket and enrolls the caller's device key.
 *
 * Policy stays with the caller: this module knows framing, ALPNs, and
 * forwarding — never vaults or tickets.
 */

import http from 'node:http';
import type { Accepting, Connection, Endpoint, RecvStream, SendStream } from './iroh.js';
import { iroh } from './iroh.js';
import type { TunnelRequestHeader, TunnelResponseHeader } from './protocol.js';
import {
  alpnBytes,
  CLOSE_UNAUTHORIZED,
  encodeHeaderFrame,
  readBodyToEnd,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_AUTH_MODE_HEADER,
  TUNNEL_AUTH_WEB_SESSION,
  TUNNEL_ALPN,
} from './protocol.js';
import type { TunnelUpstream } from './desktop-tunnel.js';

export const GW_PAIR_ALPN = 'centraid/gw-pair/1';

/** Ticket redemption over `centraid/gw-pair/1` — one frame each way. */
export interface GatewayPairRequest {
  /** Ticket id (public half of the one-time ticket). */
  ticketId: string;
  /** One-time secret (private half). */
  secret: string;
  deviceName: string;
  platform: string;
}

export interface GatewayPairResponse {
  ok: boolean;
  error?: string;
  /** Owner-facing gateway name. */
  gatewayName?: string;
  /** The vault the redeemed ticket enrolled the device into. */
  vaultId?: string;
  vaultName?: string;
  /** Version handshake material (issue #289): exact-match or refuse in v0. */
  version?: string;
  schemaEpoch?: number;
}

export interface GatewayEndpointOptions {
  /** 32-byte endpoint secret; omit to generate a fresh identity. */
  secretKey?: Uint8Array;
  /** Resolved per request so the endpoint follows gateway restarts. */
  upstream: () => TunnelUpstream | undefined | Promise<TunnelUpstream | undefined>;
  /**
   * Admit a tunnel connection from this device key? Consulted per
   * connection AND per stream, so a revocation lands on live connections.
   */
  authorize: (endpointId: string) => boolean;
  /** Redeem a pairing ticket presented by `endpointId`. */
  pair: (
    request: GatewayPairRequest,
    endpointId: string,
  ) => GatewayPairResponse | Promise<GatewayPairResponse>;
  /**
   * Headers injected into every forwarded request (the calling device's
   * identity + an in-process trust proof). Any client-supplied header of
   * the same name is dropped first — a device cannot impersonate another.
   */
  requestHeaders?: (endpointId: string) => Record<string, string>;
  /** `disabled` keeps tests offline; production uses the n0 relays + discovery. */
  relays?: 'n0' | 'disabled';
}

export interface GatewayEndpointHandle {
  /** The gateway's stable transport identity (base32 EndpointId). */
  endpointId: string;
  /** Current dial ticket (recomputed — the addr can change with the network). */
  ticket(): string;
  close(): Promise<void>;
}

export async function startGatewayEndpoint(
  options: GatewayEndpointOptions,
): Promise<GatewayEndpointHandle> {
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === 'disabled') builder.relayMode(iroh.RelayMode.disabled());
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  builder.alpns([alpnBytes(TUNNEL_ALPN), alpnBytes(GW_PAIR_ALPN)]);
  const endpoint = await builder.bind();

  const server = new GatewayEndpoint(endpoint, options);
  server.runAcceptLoop();
  return server.handle();
}

class GatewayEndpoint {
  private closed = false;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly options: GatewayEndpointOptions,
  ) {}

  handle(): GatewayEndpointHandle {
    return {
      endpointId: this.endpoint.id().toString(),
      ticket: () => iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
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
    if (alpn === GW_PAIR_ALPN) {
      await this.handlePairConnection(connection);
      return;
    }
    await this.handleTunnelConnection(connection);
  }

  private async handlePairConnection(connection: Connection): Promise<void> {
    try {
      const bi = await connection.acceptBi();
      const request = await readHeaderFrame<GatewayPairRequest>(bi.recv);
      const endpointId = connection.remoteId().toString();
      const response =
        typeof request?.ticketId === 'string' && typeof request?.secret === 'string'
          ? await this.options.pair(request, endpointId)
          : ({ ok: false, error: 'bad_request' } satisfies GatewayPairResponse);
      await bi.send.writeAll(encodeHeaderFrame(response));
      await bi.send.finish();
    } catch {
      // Malformed pairing attempt; drop it.
    } finally {
      setTimeout(() => connection.close(0n, []), 1000);
    }
  }

  private async handleTunnelConnection(connection: Connection): Promise<void> {
    const endpointId = connection.remoteId().toString();
    if (!this.options.authorize(endpointId)) {
      connection.close(CLOSE_UNAUTHORIZED, alpnBytes('unauthorized'));
      return;
    }
    try {
      for (;;) {
        const bi = await connection.acceptBi();
        // Revocation guard: enrollment is consulted per stream, so a
        // revoked device loses access even on a connection that predates it.
        if (!this.options.authorize(endpointId)) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes('revoked'));
          return;
        }
        void this.serveStream(endpointId, bi.send, bi.recv).catch(() => {
          // Per-request failures already answered with an error frame when possible.
        });
      }
    } catch {
      // Connection closed (by peer, revocation, or shutdown).
    }
  }

  private async serveStream(endpointId: string, send: SendStream, recv: RecvStream): Promise<void> {
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
    const authMode = headers[TUNNEL_AUTH_MODE_HEADER];
    delete headers[TUNNEL_AUTH_MODE_HEADER];
    // Identity injection: strip any client-supplied copy FIRST, then stamp
    // the connection's cryptographic identity — the device key is what the
    // QUIC handshake proved, never what the client claims.
    const injected = this.options.requestHeaders?.(endpointId) ?? {};
    for (const name of Object.keys(injected)) delete headers[name.toLowerCase()];
    Object.assign(headers, injected);
    headers.host = base.host;
    // Browser-generated apps carry a one-app cookie minted by WebAppSessions.
    // Omitting the broad device bearer lets the HTTP authorizer apply that
    // cookie's route scope. The marker itself is always stripped upstream.
    if (authMode === TUNNEL_AUTH_WEB_SESSION) delete headers.authorization;
    else headers.authorization = `Bearer ${upstream.token}`;
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
              await send.writeAll(bytesToArray(chunk as Buffer));
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
      await send.writeAll(bytesToArray(body));
      await send.finish();
    } catch {
      // Stream already gone.
    }
  }
}

/**
 * Convert response bytes to the `Array<number>` the iroh `SendStream.writeAll`
 * binding requires. The native `Vec<u8>` parameter rejects a `Buffer` /
 * `Uint8Array` at runtime ("Failed to get Array length" — it validates
 * `Array.isArray`), so a copy-free write of the Buffer itself is not possible
 * through this binding; the conversion is an unavoidable single copy. A
 * preallocated loop is used over `Array.from(buf)` to skip the iterator
 * protocol on this per-chunk hot path. Compression (issue #404) is what
 * actually shrinks the byte volume crossing here.
 */
function bytesToArray(buf: Buffer): Array<number> {
  const out = new Array<number>(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i]!;
  return out;
}
