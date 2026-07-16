import type { ReplicaIntent, ReplicaInvalidation } from './types.js';

/** Derive app-visible overlay events for every durable intent transition. */
export function replicaIntentInvalidations(
  intents: readonly ReplicaIntent[],
): ReplicaInvalidation[] {
  const values = new Map<string, ReplicaInvalidation>();
  for (const intent of intents) {
    for (const dependency of intent.dependencies ?? []) {
      const invalidation: ReplicaInvalidation = {
        ...dependency,
        source: 'overlay',
        intentId: intent.intentId,
        intentState: intent.state,
      };
      values.set(
        `${intent.intentId}\u0000${invalidation.shapeId}\u0000${invalidation.entity}\u0000`,
        invalidation,
      );
    }
    for (const mutation of intent.optimistic) {
      const invalidation: ReplicaInvalidation = {
        shapeId: mutation.shapeId,
        entity: mutation.entity,
        rowId: mutation.rowId,
        source: 'overlay',
        intentId: intent.intentId,
        intentState: intent.state,
      };
      values.set(
        `${intent.intentId}\u0000${invalidation.shapeId}\u0000${invalidation.entity}\u0000${invalidation.rowId}`,
        invalidation,
      );
    }
  }
  return [...values.values()];
}
