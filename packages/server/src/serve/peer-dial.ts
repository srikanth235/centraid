import {
  createTunnelClient,
  endpointTicketFor as ticketForRoute,
  tunnelRequest,
} from "@centraid/tunnel";
import type { TunnelClient } from "@centraid/tunnel";

import type { PeerDial, PeerRequest } from "./peer-link-client.js";

export interface PeerDialHandle extends PeerDial {
  close: () => Promise<void>;
}

export interface StartPeerDialOptions {
  secretKey: Uint8Array;
  relays?: "n0" | "disabled";
}

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
