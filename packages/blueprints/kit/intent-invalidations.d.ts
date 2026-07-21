// Type contract for the shared intent-invalidation derivation (issue #420).
// Hand-authored so the vanilla kit module carries no package dependency.
//
// These are STRUCTURAL mirrors of the client's replica types
// (packages/client/src/replica/types.ts) — `ReplicaIntent` and
// `ReplicaInvalidation` there are richer supersets that remain assignable to
// the shapes below. packages/client re-exports `replicaIntentInvalidations`
// from ./src/replica/intent-invalidations.ts, casting it to its own
// `(intents: readonly ReplicaIntent[]) => ReplicaInvalidation[]` signature.

/** Durable-intent lifecycle state (mirrors client's `IntentState` union). */
export type IntentState =
  | 'queued'
  | 'sending'
  | 'awaiting-change'
  | 'parked'
  | 'executed'
  | 'denied'
  | 'failed';

/** One replica read a settled intent must invalidate (mirrors `ReplicaDependency`). */
export interface IntentDependency {
  shapeId: string;
  entity: string;
}

/** One optimistic mutation an intent carries (the fields this function reads). */
export interface IntentOptimisticMutation {
  shapeId: string;
  entity: string;
  rowId: string;
}

/**
 * A `ReplicaIntent` as far as this derivation is concerned. Only the first four
 * fields are read; the rest are declared (all optional, permissive) so the
 * richer intents both callers pass — client's full `ReplicaIntent` and the
 * harness's inline literals — satisfy the shape without an excess-property
 * error and without this kit module importing the client's types.
 */
export interface IntentInvalidationInput {
  intentId: string;
  state: IntentState;
  optimistic: readonly IntentOptimisticMutation[];
  dependencies?: readonly IntentDependency[];
  // Carried by callers, ignored here.
  payloadHash?: string;
  appId?: string;
  action?: string;
  input?: unknown;
  createdOrder?: number;
  attempts?: number;
  reason?: string;
  output?: unknown;
}

/** One derived overlay invalidation (structural mirror of `ReplicaInvalidation`). */
export interface OverlayInvalidation {
  shapeId: string;
  entity: string;
  rowId?: string;
  source: 'overlay';
  intentId?: string;
  intentState?: IntentState;
}

/** Derive app-visible overlay events for every durable intent transition. */
export function replicaIntentInvalidations(
  intents: readonly IntentInvalidationInput[],
): OverlayInvalidation[];
