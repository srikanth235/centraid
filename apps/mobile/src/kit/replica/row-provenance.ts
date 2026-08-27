// What a mounted row says about its own source (#880).
//
// AN UNSTAMPED ROW IS WRITABLE: a single-vault replica, a locally projected
// pending row and a test fixture carry no provenance at all, and a missing
// stamp is not a refusal.

import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_LABELS,
} from "../../lib/replica/multi-vault-provenance";

/** The ONE sentence for this truth on the phone, read by five apps. */
export const READ_ONLY_SOURCE_REASON =
  "This vault is read-only for you, so meaning cannot be written into it.";

/** `object`, not a record type: the stamps ride on rows each app has already
 *  narrowed into a view model, and an interface has no index signature. */
export function rowCanWrite(row: object | undefined | null): boolean {
  return row ? fieldOf(row, REPLICA_CAN_WRITE) !== false : true;
}

/** Every source carrying the row, for a DETAIL surface's source line. */
export function rowScopeLabels(row: object | undefined | null): string[] {
  const labels = row ? fieldOf(row, REPLICA_SCOPE_LABELS) : undefined;
  return Array.isArray(labels)
    ? labels.filter((entry): entry is string => typeof entry === "string")
    : [];
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

/** A refused verb keeps ONE text slot: label, em dash, why. */
export function refusedLabel(label: string, reason: string): string {
  return `${label} — ${reason}`;
}
