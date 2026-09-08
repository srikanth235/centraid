// DELETING A SEAT NOBODY HAS OPEN (#996, R9; #599).
//
// A terminal purge — unpair, revoke, remove a gateway — has to reach scopes
// this renderer never mounted: a vault the member used yesterday, on a browser
// that has since restarted, has a file and no session. So this opens the seat's
// worker for the sole purpose of unlinking its file, and closes it again.
//
// IT OPENS NOTHING IT DOES NOT NEED. No bootstrap, no log tail, no outbox: the
// `open` call attaches the file so `purge` knows which one to remove, and that
// is the whole exchange. A seat that was never bootstrapped has no file, and
// unlinking a name the pool never held is a no-op rather than an error.

import { replicaStorageKey } from "../key.js";
import type { ReplicaIdentity } from "../types.js";
import {
  defaultSeatWorkerFactory,
  SeatWorkerClient,
} from "./seat-worker-client.js";
import type { SeatWorkerFactory } from "./seat-worker-client.js";

/** The seat file's name for an identity — the same one `seatOptionsFor` builds. */
export async function seatDatabaseName(
  identity: ReplicaIdentity
): Promise<string> {
  return `/centraid-seat-${await replicaStorageKey(identity)}.sqlite3`;
}

export async function purgeSeatStorage(
  identity: ReplicaIdentity,
  workerFactory: SeatWorkerFactory = defaultSeatWorkerFactory
): Promise<void> {
  const client = new SeatWorkerClient(workerFactory());
  try {
    await client.open({
      vaultId: identity.vaultId,
      dbName: await seatDatabaseName(identity),
      // Irrelevant to a purge, and `false` is the answer that promises least.
      remember: false,
    });
    await client.purge();
  } finally {
    await client.close();
  }
}
