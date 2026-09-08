// THE BROWSER'S END OF THE SEAT OUTBOX (#996, R24).
//
// `SeatIntentStore` lives in the seat's own file, and that single fact is what
// lets an executed answer clear its overlay in the transaction that carries its
// commit. On the phone the queue reaches it by calling it; in the browser the
// file is behind a Worker, because the applier walks hundreds of thousands of
// rows and must not do that on the thread that paints.
//
// So this is the same store, at a distance: every method forwards over the
// `outbox` op and nothing else happens here. NO CACHING, NO OPTIMISM, NO LOCAL
// ORDERING. The queue's whole correctness argument is that one durable table
// decides state transitions; a proxy that answered from memory would be a
// second writer with a different opinion, which is precisely the failure the
// outbox-in-the-seat-file design exists to remove.
//
// `settlesByCommitSeq` is TRUE and is not forwarded: it is a fact about the
// store on the far side, which is a `SeatIntentStore` by construction, and
// asking the worker for a constant would be a round trip for nothing.

import type {
  IntentRecordStore,
  NewStoredIntent,
} from "../intent-record-store.js";
import type { IntentOutcome, IntentState, ReplicaIntent } from "../types.js";
import type { SeatOutboxCaller } from "./seat-worker-client.js";

export class SeatWorkerOutbox implements IntentRecordStore {
  /** The seat has the applied-commit cursor; see `SeatIntentStore`. */
  readonly settlesByCommitSeq = true;

  constructor(private readonly client: SeatOutboxCaller) {}

  add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    return this.client.outboxCall<ReplicaIntent>("add", [intent]);
  }

  get(intentId: string): Promise<ReplicaIntent | undefined> {
    return this.client.outboxCall<ReplicaIntent | undefined>("get", [intentId]);
  }

  list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    return this.client.outboxCall<ReplicaIntent[]>("list", [states]);
  }

  claimNext(): Promise<ReplicaIntent | undefined> {
    return this.client.outboxCall<ReplicaIntent | undefined>("claimNext", []);
  }

  transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    return this.client.outboxCall<ReplicaIntent>("transition", [
      intentId,
      allowed,
      patch,
    ]);
  }

  settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    return this.client.outboxCall<ReplicaIntent>("settle", [
      intentId,
      allowed,
      patch,
    ]);
  }

  listSettled(limit?: number): Promise<IntentOutcome[]> {
    return this.client.outboxCall<IntentOutcome[]>("listSettled", [limit]);
  }

  clear(): Promise<void> {
    return this.client.outboxCall<void>("clear", []);
  }

  close(): void {
    // The driver is the SEAT's, shared with the applier and the reader. The
    // same rule `SeatIntentStore.close` states, and for the same reason.
  }

  destroy(): Promise<void> {
    return this.client.outboxCall<void>("destroy", []);
  }
}
