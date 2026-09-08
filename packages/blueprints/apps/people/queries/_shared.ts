/*
 * Not a query (dispatcher maps a name to `queries/<name>.ts`). WHAT IS SHARED WITH A PERSON IS NOT READ HERE (#825) — grants go through `GET /centraid/_vault/grants?partyId=`, and since #929 that live read is also where an UNDELIVERED share shows as still on its way; there is no second, vault-side invitation plane to read.
 * GRACEFUL DENIAL: catch → `null` ("facts absent"), never a consent wall over the roster.
 */

import { inList, readPages } from "../../_shared/paged-reads.ts";

/** A roster's bindings are `in`-bounded by the roster; the walk states its own
 *  ceiling rather than restating the caller's id count as a window. */
interface BindingCtx {
  vault: Pick<VaultApi, "page">;
}

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
  ctx: BindingCtx,
  partyIds: string[]
): Promise<BindingRow[] | null> {
  if (partyIds.length === 0) return [];
  try {
    const partyIn = inList("party_id", partyIds);
    return await readPages<BindingRow>(ctx, {
      name: "people.shared.liveBindings",
      select: "binding_id, party_id, vault_id, linked_at",
      from: "share_party_vault_binding",
      where: `${partyIn.sql} AND revoked_at IS NULL`,
      bind: partyIn.bind,
      order: {
        sortColumn: "binding_id",
        pkColumn: "binding_id",
        descending: false,
      },
    });
  } catch {
    return null;
  }
}

export async function readPersonShareLinks(
  ctx: BindingCtx,
  partyId: string
): Promise<PersonShareLinks | null> {
  try {
    const bindings = await readPages<BindingRow>(ctx, {
      name: "people.shared.personLinks",
      select: "binding_id, party_id, vault_id, linked_at",
      from: "share_party_vault_binding",
      where: "party_id = ? AND revoked_at IS NULL",
      bind: [partyId],
      order: {
        sortColumn: "binding_id",
        pkColumn: "binding_id",
        descending: false,
      },
    });
    return {
      vaults: bindings.map((b) => ({
        binding_id: b.binding_id,
        vault_id: b.vault_id,
        linked_at: b.linked_at,
      })),
    };
  } catch {
    return null;
  }
}
