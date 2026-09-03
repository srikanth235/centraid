import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_LABELS,
} from "../../lib/replica/multi-vault-provenance";

export const READ_ONLY_SOURCE_REASON =
  "This vault is read-only for you, so meaning cannot be written into it.";

export function rowCanWrite(row: object | undefined | null): boolean {
  return row ? fieldOf(row, REPLICA_CAN_WRITE) !== false : true;
}

export function rowScopeLabels(row: object | undefined | null): string[] {
  const labels = row ? fieldOf(row, REPLICA_SCOPE_LABELS) : undefined;
  return Array.isArray(labels)
    ? labels.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function fieldOf(row: object, field: string): unknown {
  return (row as Readonly<Record<string, unknown>>)[field];
}

export function readOnlyRouteReason(
  rows: readonly { canWrite: boolean }[]
): string | null {
  if (rows.length === 0) return null;
  return rows.every((row) => !row.canWrite) ? READ_ONLY_SOURCE_REASON : null;
}

export function refusedLabel(label: string, reason: string): string {
  return `${label} — ${reason}`;
}
