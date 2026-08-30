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
  row: Pick<
    StoredReplicaRow,
    "primary_key" | "columns_json" | "has_unavailable_fields"
  >
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

export type StoredReplicaRowValues = Pick<
  StoredReplicaRow,
  | "row_id"
  | "payload_json"
  | "oversized_json"
  | "has_unavailable_fields"
  | "server_version"
>;

/** Decode without adding a mounted-scope identity prefix. */
export function storedReplicaEnvelope(
  row: StoredReplicaRowValues,
  extra: ReplicaRow = {}
): ReplicaRowEnvelope {
  return {
    rowId: row.row_id,
    values: {
      ...(JSON.parse(row.payload_json) as ReplicaRow),
      ...extra,
    },
    oversizedFields: parseStringArray(row.oversized_json),
    hasUnavailableFields: row.has_unavailable_fields === 1,
    ...(row.server_version > 0 ? { rowVersion: row.server_version } : {}),
  };
}

/** Runs only after rows and outbox compose in their unprefixed domain. */
export function replicaScopeEnvelope(
  scope: MountedReplicaScope,
  row: ReplicaRowEnvelope
): ReplicaRowEnvelope {
  return {
    ...row,
    rowId: `${scope.vaultId}:${row.rowId}`,
    values: {
      ...row.values,
      [REPLICA_SCOPE_ID]: scope.vaultId,
      [REPLICA_SCOPE_LABEL]: scope.label,
      [REPLICA_SCOPE_IDS]: [scope.vaultId],
      [REPLICA_SCOPE_LABELS]: [scope.label],
      [REPLICA_WRITABLE_SCOPE_IDS]: scope.canWrite ? [scope.vaultId] : [],
      [REPLICA_CAN_WRITE]: scope.canWrite,
    },
  };
}

/**
 * Collapse equal bytes into ONE consistent source row: payload id and
 * `__centraidScopeId` come from the same vault, so A's id never reaches
 * writable B merely because B badged the same sha. `mountOrder` picks that row
 * and orders badges; omit it to keep first-seen, which federated search wants
 * because it composes hits one scope at a time (#883 D1).
 */
export function dedupeReplicaRowsByContent(
  rows: readonly ReplicaRowEnvelope[],
  mountOrder: readonly string[] = []
): ReplicaRowEnvelope[] {
  const groups = new Map<string, ReplicaRowEnvelope[]>();
  for (const row of rows) {
    const values = row.values;
    const hash =
      stringValue(values.sha256) ??
      stringValue(values.content_sha256) ??
      stringValue(values.blob_sha256);
    const key = hash ? `sha256:${hash}` : `row:${row.rowId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  // A group keeps its FIRST member's position, so collapsing never reorders.
  return [...groups.values()].map((group) =>
    collapseSources(group, mountOrder)
  );
}

function collapseSources(
  group: readonly ReplicaRowEnvelope[],
  mountOrder: readonly string[]
): ReplicaRowEnvelope {
  const first = group[0]!;
  if (group.length === 1) return first;
  const rank = (row: ReplicaRowEnvelope): number => {
    const id = row.values[REPLICA_SCOPE_ID];
    const at = typeof id === "string" ? mountOrder.indexOf(id) : -1;
    // An unranked source keeps its arrival position: `sort` is stable.
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const ordered = [...group].sort((left, right) => rank(left) - rank(right));
  const primary =
    ordered.find((row) => row.values[REPLICA_CAN_WRITE] === true) ??
    ordered[0]!;
  const scopeIds = unionStrings(ordered, REPLICA_SCOPE_IDS);
  const scopeLabels = unionStrings(ordered, REPLICA_SCOPE_LABELS);
  const writableScopeIds = unionStrings(ordered, REPLICA_WRITABLE_SCOPE_IDS);
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
  const ranked = ordered
    .map((row) => ({ row, rank: numericValue(row.values._rank) }))
    .filter(
      (entry): entry is { row: ReplicaRowEnvelope; rank: number } =>
        entry.rank !== undefined
    );
  let best = ranked[0];
  if (best) {
    for (const entry of ranked) {
      if (entry.rank < best.rank) best = entry;
    }
    merged.values._rank = best.rank;
    merged.values._snippet = best.row.values._snippet ?? "";
  }
  return merged;
}

function unionStrings(
  rows: readonly ReplicaRowEnvelope[],
  column: string
): string[] {
  return [...new Set(rows.flatMap((row) => arrayStrings(row.values[column])))];
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

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
