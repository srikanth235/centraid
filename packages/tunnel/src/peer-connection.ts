/*
 * Peer-plane connection loop for the pure-JS gateway endpoint (issue #726 P3).
 *
 * Deliberately NOT the device loop:
 *
 *  - admission asks `authorizePeer`, never the device-enrollment predicate. A
 *    linked gateway is a foreign principal acting for its own vault; a paired
 *    device acts for THIS gateway's owner. Reusing one decision for both is
 *    the privilege escalation this plane exists to prevent.
 *  - every stream is re-authorized, so unlinking lands on a live connection.
 *  - every stream is metered by the per-link budget (threat 7). A peer over
 *    budget is refused as a typed state; the stream is never queued.
 *
 * Path confinement lives in `serve`, which the endpoint supplies — see
 * `isPeerPlaneTarget` in protocol.ts.
 */

import type { Connection, RecvStream, SendStream } from "./iroh.js";
import type { TokenBucket } from "./peer-budget.js";
import { alpnBytes, CLOSE_UNAUTHORIZED } from "./protocol.js";

export interface PeerConnectionDeps {
  /** Is this endpoint a known, non-revoked link (or a live ceremony)? */
  authorize: (endpointId: string) => boolean;
  budget: TokenBucket;
  /** Forward one peer-plane stream; owns the `/centraid/_peer/` guard. */
  serve: (
    endpointId: string,
    send: SendStream,
    recv: RecvStream
  ) => Promise<void>;
  /** Answer a typed refusal frame on this stream. */
  refuse: (send: SendStream, status: number, state: string) => Promise<void>;
  /** Called on entry/exit so the endpoint can revoke live peer transports. */
  track?: (endpointId: string, connection: Connection) => void;
  untrack?: (endpointId: string, connection: Connection) => void;
}

export async function servePeerConnection(
  connection: Connection,
  deps: PeerConnectionDeps
): Promise<void> {
  const endpointId = connection.remoteId().toString();
  if (!deps.authorize(endpointId)) {
    // No distinguishing signal between "never linked" and "link revoked":
    // an unlinked caller learns nothing about this gateway's topology.
    connection.close(CLOSE_UNAUTHORIZED, alpnBytes("not_found"));
    return;
  }
  deps.track?.(endpointId, connection);
  try {
    const serveNextStream = async (): Promise<void> => {
      const bi = await connection.acceptBi();
      if (!deps.authorize(endpointId)) {
        connection.close(CLOSE_UNAUTHORIZED, alpnBytes("not_found"));
        return;
      }
      if (deps.budget.take(endpointId)) {
        void deps.serve(endpointId, bi.send, bi.recv).catch(() => {
          // Per-stream failures already answered with a refusal frame.
        });
      } else {
        void deps.refuse(bi.send, 429, "rate_limited").catch(() => undefined);
      }
      return serveNextStream();
    };
    await serveNextStream();
  } catch {
    // Connection closed (by the peer, by unlinking, or by shutdown).
  } finally {
    deps.untrack?.(endpointId, connection);
  }
}
