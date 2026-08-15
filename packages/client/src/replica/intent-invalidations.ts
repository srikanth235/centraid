// The ONE derivation that turns a set of durable replica intents into the
// app-visible overlay invalidations. The replica coordinator and the
// blueprints app-boot harness both drive their overlay events through it, so
// the fold lands once.
import type { ReplicaIntent, ReplicaInvalidation } from "./types.js";

/**
 * Derive app-visible overlay events for every durable intent transition.
 * Dependencies fold to per-shape/entity invalidations (no rowId); optimistic
 * mutations fold to per-row invalidations. A Map keyed on
 * `intentId`/`shapeId`/`entity`/`rowId?` joined by NUL — a byte no id can
 * carry, so the key cannot collide across fields — dedups repeats within a
 * batch.
 */
export function replicaIntentInvalidations(
  intents: readonly ReplicaIntent[]
): ReplicaInvalidation[] {
  const values = new Map<string, ReplicaInvalidation>();
  for (const intent of intents) {
    for (const dependency of intent.dependencies ?? []) {
      const invalidation: ReplicaInvalidation = {
        ...dependency,
        source: "overlay",
        intentId: intent.intentId,
        intentState: intent.state,
      };
      values.set(
        `${intent.intentId}\u0000${invalidation.shapeId}\u0000${invalidation.entity}\u0000`,
        invalidation
      );
    }
    for (const mutation of intent.optimistic) {
      const invalidation: ReplicaInvalidation = {
        shapeId: mutation.shapeId,
        entity: mutation.entity,
        rowId: mutation.rowId,
        source: "overlay",
        intentId: intent.intentId,
        intentState: intent.state,
      };
      values.set(
        `${intent.intentId}\u0000${invalidation.shapeId}\u0000${invalidation.entity}\u0000${invalidation.rowId}`,
        invalidation
      );
    }
  }
  return [...values.values()];
}
