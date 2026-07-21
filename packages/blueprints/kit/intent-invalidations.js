// Shared intent-invalidation derivation (issue #420) — the ONE function that
// turns a set of durable replica intents into the app-visible overlay
// invalidations. Canonical copy: packages/blueprints/kit/intent-invalidations.js.
// Both packages/client (whose replica coordinator re-exports it from
// ./src/replica/intent-invalidations.ts) and the blueprints app-boot harness
// (packages/blueprints/src/app-boot-harness.ts) drive their overlay events
// through this single source, so the derivation lands once.
//
// This is a plain, dependency-free ESM module: the client keeps its own richer
// `ReplicaIntent` / `ReplicaInvalidation` types (packages/client/src/replica/
// types.ts); the structural contract this module accepts and returns lives in
// the hand-authored intent-invalidations.d.ts sibling.

/**
 * Derive app-visible overlay events for every durable intent transition.
 * Dependencies fold to per-shape/entity invalidations (no rowId); optimistic
 * mutations fold to per-row invalidations. A Map keyed on
 * `intentId\0shapeId\0entity\0rowId?` dedups repeats within a batch.
 * @param {readonly import('./intent-invalidations.js').IntentInvalidationInput[]} intents
 * @returns {import('./intent-invalidations.js').OverlayInvalidation[]}
 */
export function replicaIntentInvalidations(intents) {
  const values = new Map();
  for (const intent of intents) {
    for (const dependency of intent.dependencies ?? []) {
      const invalidation = {
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
      const invalidation = {
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
