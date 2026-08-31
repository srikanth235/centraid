/*
 * Gateway side of the iroh transport (#289): one endpoint whose EndpointId is
 * the gateway's PERMANENT identity — no domain, no TLS cert, no HTTP port.
 * Devices speak `centraid/tunnel/1` and pair over `centraid/gw-pair/1`; a
 * GATEWAY speaks `centraid/gw-link/1` and reaches `/centraid/_peer/*` alone.
 * That plane's admission and identity headers stay DISJOINT from the device
 * lane's, or a link is indistinguishable from an owner device (#726). Policy
 * stays with the caller: framing, ALPNs and forwarding only.
 */

import { once } from "node:events";
import http from "node:http";

import type { TunnelUpstream } from "./desktop-tunnel.js";
import type {
  Accepting,
  Connection,
  Endpoint,
  RecvStream,
  SendStream,
} from "./iroh.js";
import { iroh } from "./iroh.js";
import { createTokenBucket, PEER_PLANE_BUDGET } from "./peer-budget.js";
import { servePeerConnection } from "./peer-connection.js";
import type { TunnelRequestHeader, TunnelResponseHeader } from "./protocol.js";
import {
  alpnBytes,
  CLOSE_UNAUTHORIZED,
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  encodeHeaderFrame,
  isPeerPlaneTarget,
  MAX_REQUEST_BODY_BYTES,
  PEER_ENDPOINT_HEADER,
  PEER_LINK_ALPN,
  PEER_PROOF_HEADER,
  PEER_VAULT_HEADER,
  readBody,
  readHeaderFrame,
  sanitizeHeaders,
  TUNNEL_AUTH_MODE_HEADER,
  TUNNEL_AUTH_WEB_SESSION,
  TUNNEL_ALPN,
} from "./protocol.js";
import {
  bytesToArray,
  respondError,
  respondPeerState,
} from "./response-frames.js";

export const GW_PAIR_ALPN = "centraid/gw-pair/1";
const DATA_PLANE_RELAY_HEADER = "x-centraid-data-plane-relay";

/** Both planes: a client copy of ANY of these is dropped first. Mirrors the
 * Rust relay's FORWARDER_OWNED_HEADERS one-for-one — including the peer-vault
 * name this JS endpoint never stamps itself (#865). */
const IDENTITY_HEADER_NAMES: readonly string[] = [
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  PEER_VAULT_HEADER,
  PEER_PROOF_HEADER,
];

export interface GatewayPairRequest {
  ticketId: string;
  secret: string;
  deviceName: string;
  platform: string;
  rememberDevice?: boolean;
  /* No owner or vault field: a joining device never names its own reach. */
  grantProfile?: string[];
}

export interface GatewayPairResponse {
  ok: boolean;
  error?: string;
  enrollmentId?: string;
  gatewayId?: string;
  gatewayName?: string;
  ownerId?: string;
  ownerLabel?: string;
  vaultId?: string;
  vaultName?: string;
  vaultIds?: string[];
  vaults?: GatewayPairVault[];
  version?: string;
  protocolVersion?: number;
  minSupportedProtocol?: number;
}

export interface GatewayPairVault {
  vaultId: string;
  enrollmentId?: string;
  vaultName?: string;
}

export interface GatewayEndpointOptions {
  secretKey?: Uint8Array;
  upstream: () =>
    | TunnelUpstream
    | undefined
    | Promise<TunnelUpstream | undefined>;
  /** Per connection AND per stream, so revocation lands on live ones. */
  authorize: (endpointId: string) => boolean;
  pair: (
    request: GatewayPairRequest,
    endpointId: string
  ) => GatewayPairResponse | Promise<GatewayPairResponse>;
  requestHeaders?: (endpointId: string) => Record<string, string>;
  /** Never `authorize` (#726). Omitted ⇒ the peer ALPN is unadvertised. */
  authorizePeer?: (endpointId: string) => boolean;
  /** DISJOINT from the device names, or a peer resolves as a device. */
  peerRequestHeaders?: (endpointId: string) => Record<string, string>;
  relays?: "n0" | "disabled";
  nativeControl?: { secret: string };
}

export interface GatewayEndpointHandle {
  endpointId: string;
  ticket: () => string;
  revokeEndpoint: (endpointId: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function startGatewayEndpoint(
  options: GatewayEndpointOptions
): Promise<GatewayEndpointHandle> {
  if (options.nativeControl && options.secretKey) {
    try {
      const upstream = await options.upstream();
      if (!upstream) throw new Error("gateway upstream is unavailable");
      const { startNativeGatewayRelay } = await import("./native-relay.js");
      return await startNativeGatewayRelay({
        secretKey: options.secretKey,
        upstream,
        controlSecret: options.nativeControl.secret,
        ...(options.relays ? { relays: options.relays } : {}),
      });
    } catch {
      // An optimization, not an availability boundary: the JS relay path
      // serves when the artifact will not load.
    }
  }
  const builder = iroh.Endpoint.builder();
  builder.applyN0();
  if (options.relays === "disabled")
    builder.relayMode(iroh.RelayMode.disabled());
  if (options.secretKey) builder.secretKey(Array.from(options.secretKey));
  builder.alpns([
    alpnBytes(TUNNEL_ALPN),
    alpnBytes(GW_PAIR_ALPN),
    // No link policy ⇒ never negotiate the plane.
    ...(options.authorizePeer ? [alpnBytes(PEER_LINK_ALPN)] : []),
  ]);
  const endpoint = await builder.bind();
  if (options.relays !== "disabled") await endpoint.online();

  const server = new GatewayEndpoint(endpoint, options);
  server.runAcceptLoop();
  return server.handle();
}

class GatewayEndpoint {
  private closed = false;
  private readonly liveConnections = new Map<string, Set<Connection>>();
  private readonly peerBudget = createTokenBucket(PEER_PLANE_BUDGET);

  constructor(
    private readonly endpoint: Endpoint,
    private readonly options: GatewayEndpointOptions
  ) {}

  handle(): GatewayEndpointHandle {
    return {
      endpointId: this.endpoint.id().toString(),
      ticket: () =>
        iroh.EndpointTicket.fromAddr(this.endpoint.addr()).toString(),
      revokeEndpoint: async (endpointId) => {
        const connections = this.liveConnections.get(endpointId);
        this.liveConnections.delete(endpointId);
        for (const connection of connections ?? []) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes("revoked"));
        }
      },
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
          // Handshake failures are the remote's problem.
        });
      return acceptNext();
    };
    void acceptNext();
  }

  private async routeConnection(accepting: Accepting): Promise<void> {
    const alpn = Buffer.from(await accepting.alpn()).toString("utf8");
    const connection = await accepting.connect();
    if (alpn === GW_PAIR_ALPN) {
      await this.handlePairConnection(connection);
      return;
    }
    if (alpn === PEER_LINK_ALPN) {
      await this.handlePeerConnection(connection);
      return;
    }
    await this.handleTunnelConnection(connection);
  }

  private async handlePeerConnection(connection: Connection): Promise<void> {
    const authorize = this.options.authorizePeer;
    if (!authorize) {
      // Fail closed: here a bug reads as "no link exists".
      connection.close(CLOSE_UNAUTHORIZED, alpnBytes("not_found"));
      return;
    }
    await servePeerConnection(connection, {
      authorize,
      budget: this.peerBudget,
      serve: (endpointId, send, recv) =>
        this.serveStream(endpointId, send, recv, "peer"),
      refuse: (send, status, state) => respondPeerState(send, status, state),
      track: (endpointId, live) => this.trackConnection(endpointId, live),
      untrack: (endpointId, live) => this.untrackConnection(endpointId, live),
    });
  }

  private trackConnection(endpointId: string, connection: Connection): void {
    const live = this.liveConnections.get(endpointId) ?? new Set<Connection>();
    live.add(connection);
    this.liveConnections.set(endpointId, live);
  }

  private untrackConnection(endpointId: string, connection: Connection): void {
    const live = this.liveConnections.get(endpointId);
    if (!live) return;
    live.delete(connection);
    if (live.size === 0) this.liveConnections.delete(endpointId);
  }

  private async handlePairConnection(connection: Connection): Promise<void> {
    try {
      const bi = await connection.acceptBi();
      const request = await readHeaderFrame<GatewayPairRequest>(bi.recv);
      const endpointId = connection.remoteId().toString();
      const response =
        typeof request?.ticketId === "string" &&
        typeof request?.secret === "string"
          ? await this.options.pair(request, endpointId)
          : ({ ok: false, error: "bad_request" } satisfies GatewayPairResponse);
      await bi.send.writeAll(encodeHeaderFrame(response));
      await bi.send.finish();
    } catch {
      // Malformed pairing attempt.
    } finally {
      setTimeout(() => connection.close(0n, []), 1000);
    }
  }

  private async handleTunnelConnection(connection: Connection): Promise<void> {
    const endpointId = connection.remoteId().toString();
    if (!this.options.authorize(endpointId)) {
      connection.close(CLOSE_UNAUTHORIZED, alpnBytes("unauthorized"));
      return;
    }
    this.trackConnection(endpointId, connection);
    try {
      const serveNextStream = async (): Promise<void> => {
        const bi = await connection.acceptBi();
        // Per stream: a revoked device loses a connection that predates it.
        if (!this.options.authorize(endpointId)) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes("revoked"));
          return;
        }
        void this.serveStream(endpointId, bi.send, bi.recv).catch(() => {
          // Already answered with an error frame.
        });
        return serveNextStream();
      };
      await serveNextStream();
    } catch {
      // Closed by peer, revocation, or shutdown.
    } finally {
      this.untrackConnection(endpointId, connection);
    }
  }

  private async serveStream(
    endpointId: string,
    send: SendStream,
    recv: RecvStream,
    plane: "device" | "peer" = "device"
  ): Promise<void> {
    let header: TunnelRequestHeader;
    try {
      header = await readHeaderFrame<TunnelRequestHeader>(recv);
    } catch {
      await respondError(send, 400, "bad_request");
      return;
    }
    // Peer-supplied `target` is pasted onto the loopback base URL: confine it
    // BEFORE the upstream lookup, so the refusal cannot vary with gateway
    // state (#726). The Rust relay enforces this too.
    if (plane === "peer" && !isPeerPlaneTarget(header.target)) {
      await respondPeerState(send, 404, "not_found");
      return;
    }
    const upstream = await Promise.resolve(this.options.upstream()).catch(
      () => undefined
    );
    if (!upstream) {
      await respondError(send, 503, "gateway_unavailable");
      return;
    }
    if (typeof header.target !== "string" || !header.target.startsWith("/")) {
      await respondError(send, 400, "bad_target");
      return;
    }
    const base = new URL(upstream.baseUrl);
    const headers = sanitizeHeaders(header.headers ?? {});
    const authMode = headers[TUNNEL_AUTH_MODE_HEADER];
    delete headers[TUNNEL_AUTH_MODE_HEADER];
    // Strip any client copy FIRST, then stamp what QUIC proved. BOTH planes'
    // names go, so neither smuggles the other's identity.
    const injected =
      plane === "peer"
        ? (this.options.peerRequestHeaders?.(endpointId) ?? {})
        : (this.options.requestHeaders?.(endpointId) ?? {});
    for (const name of IDENTITY_HEADER_NAMES) delete headers[name];
    for (const name of Object.keys(injected))
      delete headers[name.toLowerCase()];
    Object.assign(headers, injected);
    delete headers[DATA_PLANE_RELAY_HEADER];
    if (this.options.nativeControl) {
      headers[DATA_PLANE_RELAY_HEADER] = this.options.nativeControl.secret;
    }
    headers.host = base.host;
    // The broad device bearer would override a `web-session` cookie's scope.
    if (authMode === TUNNEL_AUTH_WEB_SESSION) delete headers.authorization;
    else headers.authorization = `Bearer ${upstream.token}`;
    await new Promise<void>((resolve) => {
      let bodyFailed = false;
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
            const writeWindow: number[] = [];
            for await (const chunk of response) {
              await send.writeAll(bytesToArray(chunk as Buffer, writeWindow));
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
        void respondError(
          send,
          bodyFailed ? 400 : 502,
          bodyFailed ? "bad_request" : "upstream_unreachable"
        ).finally(resolve);
      });
      void readBody(
        recv,
        async (chunk) => {
          if (!request.write(chunk)) await once(request, "drain");
        },
        MAX_REQUEST_BODY_BYTES
      )
        .then(() => request.end())
        .catch(() => {
          bodyFailed = true;
          request.destroy();
        });
    });
  }
}
