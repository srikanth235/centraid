/*
 * Whether a live edge's declared field mask leaves a scope unable to search
 * everything a fuller view could (#726 P4 item 7, D10) — computed at the
 * SAME moment the mask itself is chosen (`POST /_gateway/edges`), not only
 * later when someone actually searches. `borrowed-store.ts`'s `search()`
 * enforces the same fact at query time, against the SAME signal
 * (`replica_entity_schema.has_unavailable_fields`); this is its
 * mask-selection-time twin, computed directly against the origin's physical
 * schema so the owner sees the consequence before the edge is even lent.
 *
 * The borrowed store's own FTS index is entity-generic (it indexes every
 * present string column, not a fixed named one — see `borrowed-blob-ref.ts`'s
 * sibling comment on why the gateway carries no client-side
 * `REPLICA_LOCAL_SEARCH`-style column registry). So the question here is
 * exactly "does this mask exclude ANY column the physical table has" — the
 * same test `replica-shape.ts::buildReplicaShapes` already runs to set
 * `hasUnavailableFields`, reproduced here without the grant/consent
 * machinery because the answer does not depend on who is asking.
 */

import type { DatabaseSync } from "node:sqlite";

import { resolveEntity } from "@centraid/vault";

import type { LendScope } from "./lend-grant.js";

export interface ScopeSearchReach {
  schema: string;
  table: string;
  /**
   * True when the fieldMask excludes at least one column the physical table
   * actually has. A caller (the lend surface) must render this as "search
   * won't see everything here" — a refusal named up front, not a mystery
   * discovered later as thinner-than-expected results.
   */
  masksSearchableColumns: boolean;
}

/** One entry per scope, in the same order, even for a scope this gateway
 *  cannot resolve or that names no table — fail SOFT here: this is advisory
 *  (a UI hint), never a data-access decision, so an unresolvable scope reads
 *  as "cannot tell" (`false`) rather than blocking the edge. */
export function searchReachFor(
  vault: DatabaseSync,
  scopes: readonly LendScope[]
): ScopeSearchReach[] {
  return scopes.map((scope) => {
    const table = scope.table ?? "";
    const base: ScopeSearchReach = {
      schema: scope.schema,
      table,
      masksSearchableColumns: false,
    };
    if (
      !scope.fieldMask ||
      scope.fieldMask.length === 0 ||
      table.length === 0
    ) {
      return base;
    }
    const ref = resolveEntity(`${scope.schema}.${table}`, vault);
    if (!ref) return base;
    let columns: Array<{ name: string }>;
    try {
      columns = vault
        .prepare(`PRAGMA table_info(${ref.physical})`)
        .all() as Array<{ name: string }>;
    } catch {
      return base;
    }
    const masked = new Set(scope.fieldMask);
    return {
      ...base,
      masksSearchableColumns: columns.some(
        (column) => !masked.has(column.name)
      ),
    };
  });
}
