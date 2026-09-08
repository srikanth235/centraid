/*
 * Not a query (dispatcher maps a name to `queries/<name>.ts`). WHAT IS SHARED WITH A PERSON IS NOT READ HERE (#825) — grants go through `GET /centraid/_vault/grants?partyId=`, and since #929 that live read is also where an UNDELIVERED share shows as still on its way; there is no second, vault-side invitation plane to read.
 * GRACEFUL DENIAL: catch → `null` ("facts absent"), never a consent wall over the roster.
 */

export interface BindingRow {
  binding_id: string;
  party_id: string;
  vault_id: string;
  linked_at: string;
}

export interface PersonShareLinks {
  vaults: Array<{ binding_id: string; vault_id: string; linked_at: string }>;
}

export async function readLiveBindings(
  vault: VaultApi,
  partyIds: string[]
): Promise<BindingRow[] | null> {
  if (partyIds.length === 0) return [];
  try {
    const bindings = await vault.read({
      entity: "share.party_vault_binding",
      where: [
        { column: "party_id", op: "in", value: partyIds },
        { column: "revoked_at", op: "is-null" },
      ],
      limit: Math.min(partyIds.length * 2, 2000),
    });
    return (bindings.rows ?? []) as unknown as BindingRow[];
  } catch {
    return null;
  }
}

export async function readPersonShareLinks(
  vault: VaultApi,
  partyId: string
): Promise<PersonShareLinks | null> {
  try {
    const bindings = await vault.read({
      entity: "share.party_vault_binding",
      where: [
        { column: "party_id", op: "eq", value: partyId },
        { column: "revoked_at", op: "is-null" },
      ],
    });
    return {
      vaults: ((bindings.rows ?? []) as unknown as BindingRow[]).map((b) => ({
        binding_id: b.binding_id,
        vault_id: b.vault_id,
        linked_at: b.linked_at,
      })),
    };
  } catch {
    return null;
  }
}
