import type {
  IntentAttentionRecord,
  IntentOutcome,
  IntentState,
  ReplicaIntent,
} from "./types.js";

export type NewStoredIntent = Omit<ReplicaIntent, "createdOrder">;

/**
 * The attention journal entry for a settled write that did NOT execute, or
 * undefined for one that did. Built in the same transaction that scrubs the
 * intent so a reload can rebuild the row the member still has to answer for
 * (issue #738); see {@link IntentAttentionRecord} for the input judgment.
 */
export function buildIntentAttention(
  settled: ReplicaIntent,
  settledAt = new Date().toISOString()
): IntentAttentionRecord | undefined {
  const status = settled.conflict
    ? "conflict"
    : settled.state === "denied" || settled.state === "failed"
      ? settled.state
      : undefined;
  if (status === undefined) return undefined;
  return {
    intentId: settled.intentId,
    status,
    appId: settled.appId,
    action: settled.action,
    ...(settled.reason === undefined ? {} : { reason: settled.reason }),
    optimistic: settled.optimistic,
    ...(settled.input === undefined ? {} : { input: settled.input }),
    ...(settled.conflict === undefined ? {} : { conflict: settled.conflict }),
    settledAt,
  };
}

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
  /**
   * Settled writes that did not execute and are still waiting on a member
   * (issue #738). Never auto-pruned: only `dismissAttention` or `clear`
   * removes one, because a row the grammar says must persist is not the
   * store's to forget.
   */
  attention: () => Promise<IntentAttentionRecord[]>;
  /** Forget one attention record — the member discarded or retried it. */
  dismissAttention: (intentId: string) => Promise<boolean>;
  clear: () => Promise<void>;
  close: () => void;
  destroy: () => Promise<void>;
}
