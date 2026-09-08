// What one entity's values may be on the JSON replica lane (#922, ruling
// SB-text). The sibling of `unavailable-columns.ts`: that module is the
// structural deny-list of columns a replica never sees at all, this one is the
// weight-and-kind policy for the columns it does.
//
// The FACTS live beside the entity in `schema/entity-catalog.ts` — a ceiling
// is a promise about the table, and a promise stated anywhere else drifts from
// it. This module only resolves them, so `snapshot.ts` reads one policy per
// entity per page instead of defaulting at each call site.

import { VAULT_ENTITIES } from "../schema/entity-catalog.js";
import {
  DEFAULT_REPLICA_TEXT_CEILING_BYTES,
  replicaValuesOf,
} from "../schema/entity-declaration.js";

export interface ReplicaValuePolicy {
  /** Bytes one text value of this entity may weigh and still ride in full. */
  readonly textCeilingBytes: number;
  /** Columns that are bytes, never text: deferred whatever they weigh. */
  readonly lazyColumns: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The declared policy for `entity`, or the default one.
 *
 * An ext-band table (#286) is declared by an app at runtime and has no entry
 * here; it gets the default ceiling, and `snapshot.ts`'s `Uint8Array` check
 * stays the safety net for a binary column no declaration covers.
 */
export function replicaValuePolicyOf(entity: string): ReplicaValuePolicy {
  const dot = entity.indexOf(".");
  const declaration =
    dot > 0
      ? VAULT_ENTITIES[entity.slice(0, dot)]?.[entity.slice(dot + 1)]
      : undefined;
  if (!declaration) {
    return {
      textCeilingBytes: DEFAULT_REPLICA_TEXT_CEILING_BYTES,
      lazyColumns: EMPTY,
    };
  }
  const values = replicaValuesOf(declaration);
  return {
    textCeilingBytes: values.textCeilingBytes,
    lazyColumns: values.lazyColumns ? new Set(values.lazyColumns) : EMPTY,
  };
}
