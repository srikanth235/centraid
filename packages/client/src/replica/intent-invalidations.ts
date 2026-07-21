// The derivation itself is single-sourced in the dependency-free browser kit
// (packages/blueprints/kit/intent-invalidations.js, issue #420) so the kit's
// Ask panel and this React client run identical overlay logic. This module is
// the client-typed seam: it re-exports the kit function under the client's own
// richer `ReplicaIntent` / `ReplicaInvalidation` types (which are structurally
// assignable to the kit's mirrored shapes).
import { replicaIntentInvalidations as kitReplicaIntentInvalidations } from '@centraid/blueprints/kit/intent-invalidations.js';
import type { ReplicaIntent, ReplicaInvalidation } from './types.js';

/** Derive app-visible overlay events for every durable intent transition. */
export const replicaIntentInvalidations: (
  intents: readonly ReplicaIntent[],
) => ReplicaInvalidation[] = kitReplicaIntentInvalidations;
