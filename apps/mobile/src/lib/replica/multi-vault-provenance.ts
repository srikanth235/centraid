import type {
  ReplicaEntitySchema,
  ReplicaRow,
  ReplicaRowEnvelope,
} from "@centraid/client/replica/native";
import { ReplicaProtocolError } from "@centraid/client/replica/native";

import type { MountedReplicaScope } from "./multi-vault-reader";

export const REPLICA_SCOPE_ID = "__centraidScopeId";
export const REPLICA_SCOPE_LABEL = "__centraidScopeLabel";
export const REPLICA_SCOPE_IDS = "__centraidScopeIds";
export const REPLICA_SCOPE_LABELS = "__centraidScopeLabels";
export const REPLICA_WRITABLE_SCOPE_IDS = "__centraidWritableScopeIds";
export const REPLICA_CAN_WRITE = "__centraidCanWrite";

export interface StoredReplicaRow {
  shape_id: string;
  row_id: string;
  payload_json: string;
  oversized_json: string;
  primary_key: string;
  columns_json: string;
  has_unavailable_fields: number;
  server_version: number;
  cursor_epoch: string;
  cursor_seq: number;
  coverage: "partial" | "complete";
}

export function storedSchema(
  entity: string,
  row: StoredReplicaRow
): ReplicaEntitySchema {
  return {
    entity,
    primaryKey: row.primary_key,
    columns: [
      ...parseStringArray(row.columns_json),
      REPLICA_SCOPE_ID,
      REPLICA_SCOPE_LABEL,
      REPLICA_SCOPE_IDS,
      REPLICA_SCOPE_LABELS,
      REPLICA_WRITABLE_SCOPE_IDS,
      REPLICA_CAN_WRITE,
    ],
    hasUnavailableFields: row.has_unavailable_fields === 1,
  };
}

export function replicaEnvelope(
  scope: MountedReplicaScope,
  row: StoredReplicaRow,
  extra: ReplicaRow = {}
): ReplicaRowEnvelope {
  return {
    rowId: `${scope.vaultId}:${row.row_id}`,
    values: {
      ...(JSON.parse(row.payload_json) as ReplicaRow),
      ...extra,
      [REPLICA_SCOPE_ID]: scope.vaultId,
      [REPLICA_SCOPE_LABEL]: scope.label,
      [REPLICA_SCOPE_IDS]: [scope.vaultId],
      [REPLICA_SCOPE_LABELS]: [scope.label],
      [REPLICA_WRITABLE_SCOPE_IDS]:
        scope.role === "read" ? [] : [scope.vaultId],
      [REPLICA_CAN_WRITE]: scope.role !== "read",
    },
    oversizedFields: parseStringArray(row.oversized_json),
    hasUnavailableFields: row.has_unavailable_fields === 1,
    ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
  };
}

/**
 * Collapse equal bytes while retaining one internally-consistent source row.
 *
 * The canonical row supplies both its payload id and `__centraidScopeId`.
 * Prefer a writable source when one exists, then union badges separately. This
 * prevents an id from vault A being sent to writable vault B merely because B
 * was another provenance badge on the same sha.
 */
export function dedupeReplicaRowsByContent(
  rows: readonly ReplicaRowEnvelope[]
): ReplicaRowEnvelope[] {
  const deduped = new Map<string, ReplicaRowEnvelope>();
  for (const row of rows) {
    const values = row.values;
    const hash =
      stringValue(values.sha256) ??
      stringValue(values.content_sha256) ??
      stringValue(values.blob_sha256);
    const key = hash ? `sha256:${hash}` : `row:${row.rowId}`;
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, row);
      continue;
    }
    const primary =
      current.values[REPLICA_CAN_WRITE] !== true &&
      row.values[REPLICA_CAN_WRITE] === true
        ? row
        : current;
    const scopeIds = uniqueStrings(
      current.values[REPLICA_SCOPE_IDS],
      row.values[REPLICA_SCOPE_IDS]
    );
    const scopeLabels = uniqueStrings(
      current.values[REPLICA_SCOPE_LABELS],
      row.values[REPLICA_SCOPE_LABELS]
    );
    const writableScopeIds = uniqueStrings(
      current.values[REPLICA_WRITABLE_SCOPE_IDS],
      row.values[REPLICA_WRITABLE_SCOPE_IDS]
    );
    const merged: ReplicaRowEnvelope = {
      ...primary,
      values: {
        ...primary.values,
        [REPLICA_SCOPE_IDS]: scopeIds,
        [REPLICA_SCOPE_LABELS]: scopeLabels,
        [REPLICA_WRITABLE_SCOPE_IDS]: writableScopeIds,
        [REPLICA_CAN_WRITE]: writableScopeIds.length > 0,
      },
    };
    const currentRank = numericValue(current.values._rank);
    const rowRank = numericValue(row.values._rank);
    if (currentRank !== undefined || rowRank !== undefined) {
      const best =
        rowRank !== undefined &&
        (currentRank === undefined || rowRank < currentRank)
          ? row
          : current;
      merged.values._rank = Math.min(
        currentRank ?? Number.POSITIVE_INFINITY,
        rowRank ?? Number.POSITIVE_INFINITY
      );
      merged.values._snippet = best.values._snippet ?? "";
    }
    deduped.set(key, merged);
  }
  return [...deduped.values()];
}

export function parseStringArray(raw: string): string[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new ReplicaProtocolError("Invalid attached replica string array");
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function uniqueStrings(left: unknown, right: unknown): string[] {
  return [...new Set([...arrayStrings(left), ...arrayStrings(right)])];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
