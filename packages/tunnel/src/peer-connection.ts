// Peer-plane loop (#726): admission asks `authorizePeer` ONLY — never the
// device-enrollment predicate (that reuse is privilege escalation).

import type { Connection, RecvStream, SendStream } from "./iroh.js";
import type { TokenBucket } from "./peer-budget.js";
import { alpnBytes, CLOSE_UNAUTHORIZED } from "./protocol.js";

export interface PeerConnectionDeps {
  authorize: (endpointId: string) => boolean;
  budget: TokenBucket;
  serve: (
    endpointId: string,
    send: SendStream,
    recv: RecvStream
  ) => Promise<void>;
  refuse: (send: SendStream, status: number, state: string) => Promise<void>;
  track?: (endpointId: string, connection: Connection) => void;
  untrack?: (endpointId: string, connection: Connection) => void;
}

export async function servePeerConnection(
  connection: Connection,
  deps: PeerConnectionDeps
): Promise<void> {
  const endpointId = connection.remoteId().toString();
  if (!deps.authorize(endpointId)) {
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
          // Refusal frame sent.
        });
      } else {
        void deps.refuse(bi.send, 429, "rate_limited").catch(() => undefined);
      }
      return serveNextStream();
    };
    await serveNextStream();
  } catch {
    // Peer closed / unlinked / shutdown.
  } finally {
    deps.untrack?.(endpointId, connection);
  }
}
