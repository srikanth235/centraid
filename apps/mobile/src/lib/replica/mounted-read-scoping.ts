import {
  OnlineOnlyError,
  ReplicaProtocolError,
} from "@centraid/client/replica/native";
import type {
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaReadWireResult,
  ReplicaValue,
} from "@centraid/client/replica/native";

import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_IDS,
  REPLICA_SCOPE_LABEL,
  REPLICA_SCOPE_LABELS,
  REPLICA_WRITABLE_SCOPE_IDS,
} from "./multi-vault-provenance";
import type { MountedReplicaScope } from "./multi-vault-reader";

export type MountedReadFallback =
  | "content-hash-badges"
  | "dedupe-collapse"
  | "provenance-order"
  | "provenance-comparison";

export const MOUNTED_READ_FALLBACKS: Readonly<
  Record<MountedReadFallback, string>
> = {
  "content-hash-badges":
    "The same file from several vaults shows as one row, so the whole matching set was read to keep every source badge.",
  "dedupe-collapse":
    "Copies of the same file filled this page, so the whole matching set had to be read to fill it honestly.",
  "provenance-order":
    "Sorting by which vault a row came from needs the vault, not this phone's copy.",
  "provenance-comparison":
    "Comparing which vault a row came from needs the vault, not this phone's copy.",
};

export interface MountedReadDegradation {
  fallback: MountedReadFallback;
  reason: string;
}

export interface MountedReadResult extends ReplicaReadWireResult {
  degraded?: readonly MountedReadDegradation[];
}

export function mountedReadDegradation(
  fallback: MountedReadFallback
): MountedReadDegradation {
  return { fallback, reason: MOUNTED_READ_FALLBACKS[fallback] };
}

const PROVENANCE_SCALARS: Readonly<Record<string, true>> = {
  [REPLICA_SCOPE_ID]: true,
  [REPLICA_SCOPE_LABEL]: true,
  [REPLICA_CAN_WRITE]: true,
};

const PROVENANCE_ARRAYS: Readonly<Record<string, true>> = {
  [REPLICA_SCOPE_IDS]: true,
  [REPLICA_SCOPE_LABELS]: true,
  [REPLICA_WRITABLE_SCOPE_IDS]: true,
};

export function isMountedProvenanceColumn(column: string): boolean {
  return column in PROVENANCE_SCALARS || column in PROVENANCE_ARRAYS;
}

export interface MountedScopeSelection {
  where: ReplicaFilterClause[];
  vaultIds: ReadonlySet<string>;
}

export function selectMountedScopes(
  request: Pick<ReplicaReadRequest, "where" | "orderBy">,
  scopes: readonly MountedReplicaScope[]
): MountedScopeSelection {
  if (request.orderBy && isMountedProvenanceColumn(request.orderBy.column))
    throw new OnlineOnlyError(MOUNTED_READ_FALLBACKS["provenance-order"]);
  const where: ReplicaFilterClause[] = [];
  let kept = scopes;
  for (const clause of request.where ?? []) {
    if (!isMountedProvenanceColumn(clause.column)) {
      where.push(clause);
      continue;
    }
    if (clause.column in PROVENANCE_ARRAYS) {
      throw new ReplicaProtocolError(
        `filter ${clause.op} requires scalar values`
      );
    }
    kept = kept.filter((scope) => scopeMatches(scope, clause));
  }
  return { where, vaultIds: new Set(kept.map((scope) => scope.vaultId)) };
}

function provenanceValue(
  scope: MountedReplicaScope,
  column: string
): string | boolean {
  if (column === REPLICA_SCOPE_ID) return scope.vaultId;
  if (column === REPLICA_SCOPE_LABEL) return scope.label;
  return scope.canWrite;
}

function scopeMatches(
  scope: MountedReplicaScope,
  clause: ReplicaFilterClause
): boolean {
  if (clause.op === "is-null") return false;
  if (clause.op === "not-null") return true;
  const value = provenanceValue(scope, clause.column);
  if (clause.op === "in") {
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      throw new ReplicaProtocolError(
        'Filter op "in" requires a non-empty array'
      );
    }
    return clause.value.some((candidate) => sameValue(value, candidate));
  }
  if (clause.op === "eq") return sameValue(value, clause.value);
  if (clause.op === "ne") return !sameValue(value, clause.value);
  throw new OnlineOnlyError(MOUNTED_READ_FALLBACKS["provenance-comparison"]);
}

function sameValue(
  value: string | boolean,
  candidate: ReplicaValue | undefined
): boolean {
  if (candidate === null || candidate === undefined) return false;
  if (typeof candidate === "object")
    throw new ReplicaProtocolError("filter eq requires scalar values");
  const left = typeof value === "boolean" ? Number(value) : value;
  const right = typeof candidate === "boolean" ? Number(candidate) : candidate;
  if (typeof left !== typeof right) {
    throw new OnlineOnlyError(
      "mixed-type comparison requires canonical SQLite affinity"
    );
  }
  return left === right;
}
