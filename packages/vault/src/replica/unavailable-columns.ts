import type { DatabaseSync } from "node:sqlite";

import { sealedColumnsOf } from "../schema/sealed.js";

/**
 * Host protocol credentials are identity material, not app data. They are
 * intentionally unavailable to every replica even though they predate the
 * sealed-column registry and therefore are not ciphertext-backed cells.
 */
const REPLICA_PROTOCOL_CREDENTIAL_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  // `access.agent` and `access.device` no longer appear here: their key
  // material moved to private sibling tables (#996, R3), so it is excluded by
  // TABLE rather than by column and nothing has to remember to list it.
  "access.app": ["signing_key"],
};

/** One structural deny-list shared by log snapshots, bootstrap, and lazy reads. */
export function replicaUnavailableColumnsOf(
  entity: string,
  vault?: DatabaseSync
): readonly string[] {
  return [
    ...new Set([
      ...sealedColumnsOf(entity, vault),
      ...(REPLICA_PROTOCOL_CREDENTIAL_COLUMNS[entity] ?? []),
    ]),
  ];
}
