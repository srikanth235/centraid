// What a row says about its own source (#880, narrowed by #996 wave 3).
//
// AN UNSTAMPED ROW IS WRITABLE: a locally projected pending row and a test
// fixture carry no stamp at all, and a missing stamp is not a refusal.
//
// The stamp used to be composed by the mounted reader across four attached
// databases; a seat opens ONE file, so the session stamps its own vault's
// answer on every row it returns (`lib/replica/vault-source.ts`).

import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_LABEL,
} from "../../lib/replica/vault-source";

/** The ONE sentence for this truth on the phone, read by five apps. */
export const READ_ONLY_SOURCE_REASON =
  "This vault is read-only for you, so meaning cannot be written into it.";

/** `object`, not a record type: the stamps ride on rows each app has already
 *  narrowed into a view model, and an interface has no index signature. */
export function rowCanWrite(row: object | undefined | null): boolean {
  return row ? fieldOf(row, REPLICA_CAN_WRITE) !== false : true;
}

/**
 * The source carrying the row, for a DETAIL surface's source line.
 *
 * Still a LIST, and still called `labels`, because a detail surface renders a
 * set and a one-element set is a set. It cannot hold two now — a seat opens
 * one file — but the shape is the one every caller already draws.
 */
export function rowScopeLabels(row: object | undefined | null): string[] {
  const label = row ? fieldOf(row, REPLICA_SCOPE_LABEL) : undefined;
  return typeof label === "string" && label.length > 0 ? [label] : [];
}

function fieldOf(row: object, field: string): unknown {
  return (row as Readonly<Record<string, unknown>>)[field];
}

/** The route-level statement, or `null`. A set MIXING writable and read-only
 *  sources says nothing here — its rows each carry their own answer. */
export function readOnlyRouteReason(
  rows: readonly { canWrite: boolean }[]
): string | null {
  if (rows.length === 0) return null;
  return rows.every((row) => !row.canWrite) ? READ_ONLY_SOURCE_REASON : null;
}

// `refusedLabel` is deleted (#1015, S12): a refusal is a row's own `reason`
// line in `AnchoredMenu`, not a string concatenated into a label that
// truncates. Callers pass `READ_ONLY_SOURCE_REASON` as the row's `reason`.
