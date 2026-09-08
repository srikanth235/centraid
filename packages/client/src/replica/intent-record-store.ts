import type { IntentOutcome, IntentState, ReplicaIntent } from "./types.js";

export type NewStoredIntent = Omit<ReplicaIntent, "createdOrder">;

/** Build the durable, app-visible result before the sensitive intent is scrubbed. */
export function buildIntentOutcome(settled: ReplicaIntent): IntentOutcome {
  return {
    intentId: settled.intentId,
    status: settled.conflict
      ? "conflict"
      : (settled.state as IntentOutcome["status"]),
    ...(settled.reason === undefined ? {} : { reason: settled.reason }),
    ...(settled.output === undefined ? {} : { output: settled.output }),
    ...(settled.conflict === undefined ? {} : { conflict: settled.conflict }),
    settledAt: new Date().toISOString(),
  };
}

/**
 * Durable outbox contract for optimistic intents, satisfied by the browser's
 * IndexedDB store, an in-memory store and (React Native) a SQLite table. Kept
 * DOM-free so every platform's queue and coordinator share one interface.
 */
export interface IntentRecordStore {
  /**
   * True when this store sits beside an APPLIED-COMMIT CURSOR that will reach
   * an answer's `commit_seq` (#996, R24) — which today means the seat store,
   * whose outbox shares the seat's file and whose applier clears the overlay
   * in the transaction that carries the commit.
   *
   * It matters because `commit_seq` is on every executed answer since wave 1: a
   * queue that parks on the number with no cursor behind it holds
   * `awaiting-change` forever, and the member's pending badge never clears.
   * Those stores keep the #929 signals — `answeredVersions` against
   * `holdsVersion`, or the next delta apply.
   *
   * This is the DEFAULT, not the last word: whether a cursor is actually
   * driven is a fact about the wiring, so `IntentQueueOptions` can override it
   * (a harness that drives `settleAtCommitSeq` by hand over any outbox).
   * Absent is the safe reading, so a store says this only when it means it.
   */
  readonly settlesByCommitSeq?: boolean;
  add: (intent: NewStoredIntent) => Promise<ReplicaIntent>;
  get: (intentId: string) => Promise<ReplicaIntent | undefined>;
  list: (states?: readonly IntentState[]) => Promise<ReplicaIntent[]>;
  claimNext: () => Promise<ReplicaIntent | undefined>;
  transition: (
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ) => Promise<ReplicaIntent>;
  /** Return the settled value while atomically removing its sensitive input. */
  settle: (
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ) => Promise<ReplicaIntent>;
  /** Terminal outcomes survive removal of the sensitive queued input. */
  listSettled: (limit?: number) => Promise<IntentOutcome[]>;
  clear: () => Promise<void>;
  close: () => void;
  destroy: () => Promise<void>;
}
