/*
 * Desktop side of the phone tunnel (#263). One iroh endpoint, two ALPNs:
 *  - `centraid/tunnel/1`: remote EndpointId must be allowlisted; each
 *    bi-stream is one HTTP request forwarded to the loopback gateway with
 *    the bearer attached (gateway keeps 127.0.0.1, zero HTTP changes).
 *  - `centraid/pair/1`: any endpoint may connect but must present the
 *    one-time QR pairing code; success stores its EndpointId.
 *
 * This forwarder holds no device key: the phone authenticates at the QUIC
 * layer, then we speak to the gateway AS THE HOST — client identity headers
 * are stripped and every hop marked `TUNNEL_FORWARDED_HEADER`, so host-only
 * capabilities do not mistake 127.0.0.1 for the owner (#568).
 */

import crypto from "node:crypto";
import http from "node:http";

import type { DeviceStore, PairedDevice } from "./device-store.js";
import type {
  Accepting,
  Connection,
  Endpoint,
  RecvStream,
  SendStream,
} from "./iroh.js";
import { iroh } from "./iroh.js";
import type {
  PairQrPayload,
  PairRequest,
  PairResponse,
  TunnelRequestHeader,
  TunnelResponseHeader,
} from "./protocol.js";
import {
  alpnBytes,
  CLOSE_UNAUTHORIZED,
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  encodeHeaderFrame,
  PAIR_ALPN,
  readBodyToEnd,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_ALPN,
  TUNNEL_FORWARDED_HEADER,
} from "./protocol.js";

export interface TunnelUpstream {
  /** Loopback gateway base (`http://127.0.0.1:18789`). */
  baseUrl: string;
  token: string;
}

export interface DesktopTunnelOptions {
  /** 32-byte endpoint secret; omit to generate a fresh identity. */
  secretKey?: Uint8Array;
  /** Resolved per request; follows gateway restarts/switches. */
  upstream: () =>
    | TunnelUpstream
    | undefined
    | Promise<TunnelUpstream | undefined>;
  deviceStore: DeviceStore;
  desktopName?: string;
  /** Tests pass `disabled`. */
  relays?: "n0" | "disabled";
  onPaired?: (device: PairedDevice) => void;
}

export interface ActivePairing {
  code: string;
  expiresAt: number;
  qrPayload: string;
}

export interface DesktopTunnelHandle {
  /** Stable transport identity (base32 EndpointId). */
  endpointId: string;
  /** Recomputed — the addr can change with the network. */
  ticket: () => string;
  beginPairing: (ttlMs?: number) => ActivePairing;
  activePairing: () => ActivePairing | undefined;
  cancelPairing: () => void;
  revokeDevice: (deviceId: string) => PairedDevice | undefined;
  close: () => Promise<void>;
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function startDesktopTunnel(
  options: DesktopTunnelOptions
): Promise<DesktopTunnelHandle> {
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === "disabled")
    builder.relayMode(iroh.RelayMode.disabled());
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  builder.alpns([alpnBytes(TUNNEL_ALPN), alpnBytes(PAIR_ALPN)]);
  const endpoint = await builder.bind();

  const tunnel = new DesktopTunnel(endpoint, options);
  tunnel.runAcceptLoop();
  return tunnel.handle();
}

/** Prefer the Rust byte pump; portable relay keeps linking alive if absent. */
export async function startPreferredDesktopTunnel(
  options: DesktopTunnelOptions
): Promise<DesktopTunnelHandle> {
  if (options.secretKey) {
    try {
      const { startNativeDesktopTunnel } = await import("./native-relay.js");
      return await startNativeDesktopTunnel(options);
    } catch {
      // Fall through to the portable relay.
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
    private readonly options: DesktopTunnelOptions
  ) {}

  handle(): DesktopTunnelHandle {
    return {
      endpointId: this.endpoint.id().toString(),
      ticket: () =>
        iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
      beginPairing: (ttlMs = DEFAULT_PAIRING_TTL_MS) =>
        this.beginPairing(ttlMs),
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
    const acceptNext = async (): Promise<void> => {
      let incoming;
      try {
        incoming = await this.endpoint.acceptNext();
      } catch {
        if (this.closed || this.endpoint.isClosed()) return;
        return acceptNext();
      }
      if (!incoming) return;
      void incoming
        .accept()
        .then((accepting) => this.routeConnection(accepting))
        .catch(() => {
          // Remote handshake failure; keep accepting.
        });
      return acceptNext();
    };
    void acceptNext();
  }

  private async routeConnection(accepting: Accepting): Promise<void> {
    const alpn = Buffer.from(await accepting.alpn()).toString("utf8");
    const connection = await accepting.connect();
    if (alpn === PAIR_ALPN) {
      await this.handlePairConnection(connection);
      return;
    }
    await this.handleTunnelConnection(connection);
  }

  private beginPairing(ttlMs: number): ActivePairing {
    const code = crypto.randomBytes(16).toString("base64url");
    const payload: PairQrPayload = {
      v: 1,
      kind: "centraid-pair",
      ticket: iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
      code,
    };
    this.pairing = {
      code,
      expiresAt: Date.now() + ttlMs,
      qrPayload: JSON.stringify(payload),
    };
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

  private evaluatePairRequest(
    connection: Connection,
    request: PairRequest
  ): PairResponse {
    if (
      typeof request?.code !== "string" ||
      typeof request?.deviceName !== "string"
    ) {
      return { ok: false, error: "bad_request" };
    }
    const pairing = this.pairing;
    if (!pairing || !timingSafeEqualStr(pairing.code, request.code)) {
      return { ok: false, error: "invalid_code" };
    }
    if (Date.now() > pairing.expiresAt) {
      this.pairing = undefined;
      return { ok: false, error: "expired_code" };
    }
    this.pairing = undefined; // one-time: consumed on success
    const device = this.options.deviceStore.add({
      name: request.deviceName,
      platform:
        typeof request.platform === "string" ? request.platform : "unknown",
      endpointId: connection.remoteId().toString(),
    });
    this.options.onPaired?.(device);
    return {
      ok: true,
      gatewayId: this.endpoint.id().toString(),
      deviceId: device.deviceId,
      desktopName: this.options.desktopName ?? "Centraid Desktop",
    };
  }

  private revokeDevice(deviceId: string): PairedDevice | undefined {
    const removed = this.options.deviceStore.remove(deviceId);
    if (!removed) return undefined;
    for (const [stableId, live] of this.liveConnections) {
      if (live.endpointId === removed.endpointId) {
        live.connection.close(CLOSE_UNAUTHORIZED, alpnBytes("revoked"));
        this.liveConnections.delete(stableId);
      }
    }
    return removed;
  }

  private async handleTunnelConnection(connection: Connection): Promise<void> {
    const endpointId = connection.remoteId().toString();
    if (!this.options.deviceStore.findByEndpointId(endpointId)) {
      connection.close(CLOSE_UNAUTHORIZED, alpnBytes("unauthorized"));
      return;
    }
    const stableId = connection.stableId();
    this.liveConnections.set(stableId, { connection, endpointId });
    try {
      const serveNextStream = async (): Promise<void> => {
        const bi = await connection.acceptBi();
        // Allowlist consulted per stream: revocation applies immediately.
        if (!this.options.deviceStore.findByEndpointId(endpointId)) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes("revoked"));
          return;
        }
        void this.serveStream(bi.send, bi.recv).catch(() => {
          // Per-request failures already answered with a 502 frame.
        });
        return serveNextStream();
      };
      await serveNextStream();
    } catch {
      // Closed: peer, revocation, or shutdown.
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
      await this.respondError(send, 400, "bad_request");
      return;
    }
    const upstream = await Promise.resolve(this.options.upstream()).catch(
      () => undefined
    );
    if (!upstream) {
      await this.respondError(send, 503, "gateway_unavailable");
      return;
    }
    if (typeof header.target !== "string" || !header.target.startsWith("/")) {
      await this.respondError(send, 400, "bad_target");
      return;
    }
    const base = new URL(upstream.baseUrl);
    const headers = sanitizeHeaders(header.headers ?? {});
    // Loopback is not an identity (#568): strip client identity headers and
    // mark the hop forwarded so host-only capabilities refuse it.
    delete headers[DEVICE_IDENTITY_HEADER];
    delete headers[DEVICE_PROOF_HEADER];
    headers[TUNNEL_FORWARDED_HEADER] = "1";
    headers.host = base.host;
    headers.authorization = `Bearer ${upstream.token}`;
    if (body.length > 0) headers["content-length"] = String(body.length);
    else delete headers["content-length"];

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
              headers: sanitizeHeaders(
                response.headers as Record<string, string | string[]>
              ),
            };
            await send.writeAll(encodeHeaderFrame(responseHeader));
            // Sequential writes keep chunk order; SSE stays live.
            for await (const chunk of response) {
              await send.writeAll(Array.from(chunk as Buffer));
            }
            await send.finish();
          })()
            .catch(async () => {
              await send.reset(1n).catch(() => undefined);
            })
            .finally(resolve);
        }
      );
      request.on("error", () => {
        void this.respondError(send, 502, "upstream_unreachable").finally(
          resolve
        );
      });
      request.end(body);
    });
  }

  private async respondError(
    send: SendStream,
    status: number,
    error: string
  ): Promise<void> {
    try {
      const body = Buffer.from(JSON.stringify({ error }), "utf8");
      await send.writeAll(
        encodeHeaderFrame({
          status,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
          },
        } satisfies TunnelResponseHeader)
      );
      await send.writeAll(Array.from(body));
      await send.finish();
    } catch {
      // Stream already gone.
    }
  }
}
