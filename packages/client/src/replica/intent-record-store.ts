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
