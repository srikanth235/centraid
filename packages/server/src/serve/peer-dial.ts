/*
 * The real transport behind `PeerRequest`/`PeerDial` (#726 P3 — "no
 * production peer dial"). Every peer-plane caller — `redeemLinkTicket`,
 * `pushRouteAssertion` (`peer-link-client.ts`) and the commons rail's own
 * client (`peer-commons-client.ts`) — already depend on nothing
 * more than these two transport-agnostic interfaces; this file is the ONE
 * production implementation of them, built on `@centraid/tunnel`'s generic
 * client. Tests substitute a loopback double that calls the far side's route
 * handler directly (`peer-link-ceremony.test.ts`'s `transportTo`) — this
 * module is the only caller that actually opens a `centraid/gw-link/1` QUIC
 * connection.
 *
 * The dialing identity MUST be this gateway's own persistent secret key: the
 * far side records whatever EndpointId the QUIC handshake proves as this
 * gateway's cached route (the vault's `vault_routes` row), so dialing under any
 * other identity would leave a peer unable to ever reach this gateway back.
 * The ACCEPTING side of that same identity runs elsewhere (the native relay
 * in production, `startGatewayEndpoint` otherwise, issue #289/#726) — this
 * client never accepts a connection, only opens them, so it is safe to run
 * alongside whichever accepts.
 *
 * Connections are opened fresh per request and closed after: a ceremony, a
 * give, or a chunk poll are all infrequent enough that a short-lived
 * connection needs no keep-alive or health bookkeeping. (A blob pull's many
 * chunk requests to the SAME peer therefore open many connections — flagged
 * as a follow-up optimization, not a correctness gap.)
 */

import {
  createTunnelClient,
  endpointTicketFor as ticketForRoute,
  tunnelRequest,
} from "@centraid/tunnel";
import type { TunnelClient } from "@centraid/tunnel";

import type { PeerDial } from "./peer-link-client.js";
import type { PeerRequest } from "./peer-link-client.js";

export interface PeerDialHandle extends PeerDial {
  close: () => Promise<void>;
}

export interface StartPeerDialOptions {
  /** This gateway's own persistent 32-byte endpoint secret. */
  secretKey: Uint8Array;
  /** `disabled` keeps dialing offline (tests); production uses n0 relays. */
  relays?: "n0" | "disabled";
}

/**
 * Synchronous on purpose: `peerPlane.dial` must be available the moment a
 * gateway's device plane is constructed, before the HTTP server (and so the
 * accepting endpoint, which needs its `upstream` URL) exists. Binding the
 * underlying iroh endpoint is deferred to the first actual dial.
 */
export function startPeerDial(options: StartPeerDialOptions): PeerDialHandle {
  let clientPromise: Promise<TunnelClient> | undefined;
  const client = (): Promise<TunnelClient> =>
    (clientPromise ??= createTunnelClient({
      secretKey: options.secretKey,
      ...(options.relays ? { relays: options.relays } : {}),
    }));

  const request: PeerRequest = async (input) => {
    const tunnel = await client();
    const connection = await tunnel.connectPeer(input.endpointTicket);
    try {
      const response = await tunnelRequest(connection, {
        method: input.method,
        target: input.target,
        ...(input.body === undefined
          ? {}
          : { body: Buffer.from(JSON.stringify(input.body), "utf8") }),
      });
      const raw = response.body.toString("utf8");
      return {
        status: response.status,
        json: raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined,
      };
    } finally {
      connection.close(0n, []);
    }
  };

  return {
    request,
    endpointTicketFor: (endpointId, relayHints) =>
      ticketForRoute(endpointId, relayHints[0]),
    close: async () => {
      if (!clientPromise) return;
      await (await clientPromise).close();
    },
  };
}
