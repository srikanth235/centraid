import type { IntentOutcome, IntentState, ReplicaIntent } from "./types.js";

export type NewStoredIntent = Omit<ReplicaIntent, "createdOrder">;

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
  settle: (
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ) => Promise<ReplicaIntent>;
  listSettled: (limit?: number) => Promise<IntentOutcome[]>;
  clear: () => Promise<void>;
  close: () => void;
  destroy: () => Promise<void>;
}
