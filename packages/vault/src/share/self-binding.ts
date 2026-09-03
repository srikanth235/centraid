import type { DatabaseSync } from "node:sqlite";

export function isSelfBinding(
  db: DatabaseSync,
  partyId: string,
  vaultId: string
): boolean {
  const own = db
    .prepare("SELECT vault_id, self_party_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string; self_party_id: string | null } | undefined;
  if (!own) return false;
  return own.vault_id === vaultId || own.self_party_id === partyId;
}
