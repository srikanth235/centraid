/*
 * Gateway side of the iroh transport (#289).
 *
 * The gateway daemon binds one iroh endpoint whose EndpointId is the
 * gateway's PERMANENT identity — no domain, no TLS cert, no exposed HTTP
 * port. Three ALPNs:
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
 *  - `centraid/gw-link/1`: the PEER plane (#726). Another gateway, acting
 *    for its own vault, reaches `/centraid/_peer/*` and nothing else. It has
 *    its own admission decision and its own identity headers; sharing either
 *    with the device lane would make a link indistinguishable from a paired
 *    owner device.
 *
 * Policy stays with the caller: this module knows framing, ALPNs, and
 * forwarding — never vaults or tickets.
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

/**
 * Every name a forwarder may stamp, on either plane. A client copy of ANY of
 * them is dropped before the forwarder stamps its own, so the device lane and
 * the peer lane cannot be crossed from the wire.
 */
const IDENTITY_HEADER_NAMES: readonly string[] = [
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  PEER_PROOF_HEADER,
];

/** Ticket redemption over `centraid/gw-pair/1` — one frame each way. */
export interface GatewayPairRequest {
  /** Ticket id (public half of the one-time ticket). */
  ticketId: string;
  /** One-time secret (private half). */
  secret: string;
  deviceName: string;
  platform: string;
  rememberDevice?: boolean;
  /*
   * There is deliberately NO owner OR vault field here. Both are baked into
   * the server-minted invitation and read back from `tickets` at redemption;
   * a joining device never gets to name its own principal or its own reach.
   */
  /** Optional module capability profile for a constrained companion device. */
  grantProfile?: string[];
}

export interface GatewayPairResponse {
  ok: boolean;
  error?: string;
  /** Enrollment row the newly paired device may delete to unpair itself. */
  enrollmentId?: string;
  /** Stable sovereign gateway EndpointId; relay-bearing tickets may rotate. */
  gatewayId?: string;
  /** Owner-facing gateway name. */
  gatewayName?: string;
  /** The owner this device is now bound to, and their display label (#726). */
  ownerId?: string;
  ownerLabel?: string;
  /** The first vault the redeemed invitation enrolled the device into. */
  vaultId?: string;
  vaultName?: string;
  /** Every vault the invitation granted — one scan, many vaults, atomically. */
  vaultIds?: string[];
  /**
   * Per-vault enrollment details. `vaultIds` remains for older clients that
   * only need to discover the mounted scopes; new clients use this list to
   * retain the vault-specific enrollment handle and presentation metadata.
   */
  vaults?: GatewayPairVault[];
  /** Product version (display). Protocol fields gate connect (#512). */
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
  /** 32-byte endpoint secret; omit to generate a fresh identity. */
  secretKey?: Uint8Array;
  /** Resolved per request so the endpoint follows gateway restarts. */
  upstream: () =>
    | TunnelUpstream
    | undefined
    | Promise<TunnelUpstream | undefined>;
  /**
   * Admit a tunnel connection from this device key? Consulted per
   * connection AND per stream, so a revocation lands on live connections.
   */
  authorize: (endpointId: string) => boolean;
  /** Redeem a pairing ticket presented by `endpointId`. */
  pair: (
    request: GatewayPairRequest,
    endpointId: string
  ) => GatewayPairResponse | Promise<GatewayPairResponse>;
  /**
   * Headers injected into every forwarded request (the calling device's
   * identity + an in-process trust proof). Any client-supplied header of
   * the same name is dropped first — a device cannot impersonate another.
   */
  requestHeaders?: (endpointId: string) => Record<string, string>;
  /**
   * Admit a PEER (gateway↔gateway) connection from this endpoint? Separate
   * from `authorize` on purpose (#726): the device predicate answers "is
   * this one of my owner's devices", which a linked gateway must never be
   * able to answer yes to. Omitting it means this endpoint does not speak
   * the peer plane at all — the ALPN is not even advertised.
   */
  authorizePeer?: (endpointId: string) => boolean;
  /**
   * Peer identity headers, the mirror of `requestHeaders` for the peer plane.
   * Must stamp names DISJOINT from the device ones so the HTTP layer cannot
   * resolve a peer into a device.
   */
  peerRequestHeaders?: (endpointId: string) => Record<string, string>;
  /** `disabled` keeps tests offline; production uses the n0 relays + discovery. */
  relays?: "n0" | "disabled";
  /** Authenticated loopback metadata route used by the Rust-owned relay. */
  nativeControl?: { secret: string };
}

export interface GatewayEndpointHandle {
  /** The gateway's stable transport identity (base32 EndpointId). */
  endpointId: string;
  /** Current dial ticket (recomputed — the addr can change with the network). */
  ticket: () => string;
  /** Immediately close every live transport owned by a revoked device key. */
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
      // The first-party addon is an optimization, not an availability
      // boundary. @number0/iroh's supported-platform binding still provides
      // the original JS relay path when our target artifact is absent or
      // cannot be loaded.
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
    // Advertised only when the host supplied a peer decision: a gateway with
    // no link policy must not negotiate the plane at all.
    ...(options.authorizePeer ? [alpnBytes(PEER_LINK_ALPN)] : []),
  ]);
  const endpoint = await builder.bind();

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
          // Handshake failures are the remote's problem; keep accepting.
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
      // Fail closed: a negotiated peer ALPN with no peer policy is a bug, and
      // the safe reading of a bug on this plane is "no link exists".
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
      // Malformed pairing attempt; drop it.
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
        // Revocation guard: enrollment is consulted per stream, so a
        // revoked device loses access even on a connection that predates it.
        if (!this.options.authorize(endpointId)) {
          connection.close(CLOSE_UNAUTHORIZED, alpnBytes("revoked"));
          return;
        }
        void this.serveStream(endpointId, bi.send, bi.recv).catch(() => {
          // Per-request failures already answered with an error frame when possible.
        });
        return serveNextStream();
      };
      await serveNextStream();
    } catch {
      // Connection closed (by peer, revocation, or shutdown).
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
    // Trap 1, JS half (#726). `target` is peer-supplied and is pasted onto
    // the loopback base URL below, so on the peer plane it must be proved
    // confined to `/centraid/_peer/` BEFORE anything else — including before
    // the upstream lookup, so the refusal cannot vary with gateway state. The
    // Rust relay enforces the identical rule; neither is the only guard.
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
    // Identity injection: strip any client-supplied copy FIRST, then stamp
    // the connection's cryptographic identity — the key is what the QUIC
    // handshake proved, never what the caller claims. Both planes' header
    // names are stripped regardless of plane, so a peer can never smuggle a
    // device identity (nor a device a peer one) past the HTTP layer.
    const injected =
      plane === "peer"
        ? (this.options.peerRequestHeaders?.(endpointId) ?? {})
        : (this.options.requestHeaders?.(endpointId) ?? {});
    for (const name of IDENTITY_HEADER_NAMES) delete headers[name];
    for (const name of Object.keys(injected))
      delete headers[name.toLowerCase()];
    Object.assign(headers, injected);
    // A client cannot claim it arrived through the trusted byte relay. Strip
    // its copy and stamp the control secret only on this relay-owned hop.
    delete headers[DATA_PLANE_RELAY_HEADER];
    if (this.options.nativeControl) {
      headers[DATA_PLANE_RELAY_HEADER] = this.options.nativeControl.secret;
    }
    headers.host = base.host;
    // A browser hop that marks itself `web-session` carries its own gateway
    // cookie. Omitting the broad device bearer lets the HTTP authorizer apply
    // that cookie's own scope. The marker itself is always stripped upstream.
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
            // Sequential for-await keeps chunk ordering; SSE stays live
            // because each chunk is written the moment it arrives.
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
