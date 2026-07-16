import type { IntentState, ReplicaIntent } from './types.js';

export type NewStoredIntent = Omit<ReplicaIntent, 'createdOrder'>;

/**
 * Durable outbox contract for optimistic intents, satisfied by the browser's
 * IndexedDB store, an in-memory store and (React Native) a SQLite table. Kept
 * DOM-free so every platform's queue and coordinator share one interface.
 */
export interface IntentRecordStore {
  add(intent: NewStoredIntent): Promise<ReplicaIntent>;
  get(intentId: string): Promise<ReplicaIntent | undefined>;
  list(states?: readonly IntentState[]): Promise<ReplicaIntent[]>;
  claimNext(): Promise<ReplicaIntent | undefined>;
  transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent>;
  /** Return the settled value while atomically removing its sensitive input. */
  settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent>;
  clear(): Promise<void>;
  close(): void;
  destroy(): Promise<void>;
}
