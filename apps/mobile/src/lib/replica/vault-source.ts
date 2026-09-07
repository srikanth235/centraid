// WHICH VAULT A ROW CAME FROM, AND WHETHER THE MEMBER MAY WRITE THERE.
//
// This was the mount plane's provenance (#883): six columns, three of them
// arrays, because a phone read across up to four attached databases and one
// row could legitimately have come from several of them at once. #996 wave 3
// deleted that plane — a seat opens ONE file — so the arrays are gone with the
// question they answered, and what remains is the same fact with one answer.
//
// IT IS STILL A ROW STAMP RATHER THAN A CONTEXT FLAG, because "may I write
// here" is what eighteen screens ask about a row they are drawing, and moving
// the question to the provider would mean every one of them reaching for a
// hook to answer it about data it already holds. One place stamps; nothing
// else has to know.

import type { ReplicaRowEnvelope } from "@centraid/client/replica/native";

export const REPLICA_SCOPE_ID = "__centraidScopeId";
export const REPLICA_SCOPE_LABEL = "__centraidScopeLabel";
export const REPLICA_CAN_WRITE = "__centraidCanWrite";

/** One vault this phone holds a replica of: the switcher's row, and the mount. */
export interface ReplicaVaultScope {
  vaultId: string;
  label: string;
  canWrite: boolean;
  /**
   * Derive "not my vault" from this, never `label`. Older caches omit it, and
   * absent reads as the member's own — the answer that promises nothing.
   */
  personal?: boolean;
  /** Absolute path of the replica file, for deletion and storage accounting. */
  databaseName: string;
}

/** What `stampVaultSource` needs; the switcher's extra fields are not its business. */
export type VaultSource = Pick<
  ReplicaVaultScope,
  "vaultId" | "label" | "canWrite"
>;

export function stampVaultSource(
  row: ReplicaRowEnvelope,
  source: VaultSource
): ReplicaRowEnvelope {
  return {
    ...row,
    values: {
      ...row.values,
      [REPLICA_SCOPE_ID]: source.vaultId,
      [REPLICA_SCOPE_LABEL]: source.label,
      [REPLICA_CAN_WRITE]: source.canWrite,
    },
  };
}

/**
 * The rowId is NOT prefixed with the vault. The mounted reader prefixed it
 * because two vaults could hand back the same row id and a screen holding both
 * needed them apart; one open file cannot, and a prefixed id is one the write
 * path then has to strip back off.
 */
export function stampVaultSourceRows<T extends { rows: ReplicaRowEnvelope[] }>(
  result: T,
  source: VaultSource
): T {
  return {
    ...result,
    rows: result.rows.map((row) => stampVaultSource(row, source)),
  };
}
