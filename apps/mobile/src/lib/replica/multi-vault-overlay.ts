// Replica ⊕ outbox on the multi-vault read plane (issue #738 P4).
//
// A device holds two durable local truths — canonical rows as of the cursor,
// and the intent outbox — and the honest local read is their composition. The
// single-vault path composes inside the coordinator (`overlayMutations` →
// `evaluateReplicaRead`, packages/client/src/replica). The mounted reader
// queries the ATTACHed databases directly and never passes through the
// coordinator, so without this module a queued write is durable but invisible:
// the row a member just created does not appear in the list they created it in.
//
// The composition is per vault by construction. Mounted row ids are scoped
// (`<vaultId>:<rowId>`) and every row carries its source vault, so a vault's
// mutations are applied to that vault's rows alone, and a row minted by a write
// to one vault can never overwrite, delete, or leak into another's.

import {
  applyOptimisticMutations,
  evaluateReplicaRead,
} from "@centraid/client/replica/native";
import type {
  OptimisticMutation,
  ReplicaEntitySchema,
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
} from "@centraid/client/replica/native";

import {
  REPLICA_PROVENANCE_COLUMNS,
  REPLICA_SCOPE_ID,
  scopeProvenance,
} from "./multi-vault-provenance";
import type { MountedReplicaScope } from "./multi-vault-reader";
import type { NativeReadRequest } from "./native-session";

/**
 * One mounted vault's unsettled writes against one shape. Grouped by shape
 * because column sets are per shape — and because the same app's shape id
 * differs from vault to vault, so a shape id is never a cross-vault filter.
 */
export interface ScopedOverlay {
  scope: MountedReplicaScope;
  schema: ReplicaEntitySchema;
  mutations: readonly OptimisticMutation[];
}

/**
 * Compose a mounted read result with the mounted vaults' unsettled writes.
 *
 * Applies each vault's mutations to its own rows, then re-runs the request's
 * filter/order/limit over the composed set exactly as the canonical read did:
 * a pending row obeys the same query as every other row rather than jumping
 * the list or ignoring the filter it would not match.
 */
export function composeMountedOverlay(
  result: ReplicaReadWireResult,
  request: NativeReadRequest,
  overlays: readonly ScopedOverlay[]
): ReplicaReadWireResult {
  if (overlays.length === 0) return result;
  let rows = result.rows;
  for (const overlay of overlays) rows = applyScopedOverlay(rows, overlay);
  return {
    ...result,
    rows: evaluateReplicaRead(
      rows,
      mountedSchema(request.entity, overlays),
      { ...request, shapeId: result.dependency.shapeId },
      []
    ),
  };
}

function applyScopedOverlay(
  rows: readonly ReplicaRowEnvelope[],
  { scope, schema, mutations }: ScopedOverlay
): ReplicaRowEnvelope[] {
  const prefix = `${scope.vaultId}:`;
  const owned = new Map<string, ReplicaRowEnvelope>();
  for (const row of rows) {
    if (row.values[REPLICA_SCOPE_ID] !== scope.vaultId) continue;
    const rowId = row.rowId.startsWith(prefix)
      ? row.rowId.slice(prefix.length)
      : row.rowId;
    owned.set(rowId, { ...row, rowId });
  }
  const applied = new Map(
    applyOptimisticMutations([...owned.values()], [...mutations], schema).map(
      (row) => [row.rowId, row]
    )
  );
  const composed = rows.flatMap((row) => {
    if (row.values[REPLICA_SCOPE_ID] !== scope.vaultId) return [row];
    const next = applied.get(
      row.rowId.startsWith(prefix) ? row.rowId.slice(prefix.length) : row.rowId
    );
    // Gone from the applied set means an unsettled delete removed it.
    return next ? [{ ...next, rowId: row.rowId }] : [];
  });
  // Rows this vault's outbox mints: canonical rows keep the provenance they
  // were read with, so only the new ones need it stamped on.
  const minted = [...applied.values()]
    .filter((row) => !owned.has(row.rowId))
    .map((row) => ({
      ...row,
      rowId: `${prefix}${row.rowId}`,
      values: { ...row.values, ...scopeProvenance(scope) },
    }));
  return [...composed, ...minted];
}

/**
 * The schema the composed set is filtered and ordered against: the union of
 * every contributing vault's columns plus the provenance columns the mounted
 * reader adds, so a query over either is answered the same way it was before
 * anything was pending.
 */
function mountedSchema(
  entity: string,
  overlays: readonly ScopedOverlay[]
): ReplicaEntitySchema {
  const columns = new Set(REPLICA_PROVENANCE_COLUMNS);
  for (const overlay of overlays)
    for (const column of overlay.schema.columns) columns.add(column);
  return {
    entity,
    primaryKey: overlays[0]!.schema.primaryKey,
    columns: [...columns],
    hasUnavailableFields: overlays.some(
      (overlay) => overlay.schema.hasUnavailableFields === true
    ),
  };
}
