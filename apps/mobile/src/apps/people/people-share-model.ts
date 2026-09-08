// The sharing plane for one person, split from `people-model.ts` when that
// file crossed the repo's 625-line ceiling — same contract, own module: the
// projection mirrors `queries/_shared.ts` `readPersonShareLinks` over the
// replica's own tables, and the caller hands a null row set for a read that
// failed, which nulls the answer — absent is never "nothing is shared".
//
// WHAT IS SHARED WITH THE PERSON IS NOT PROJECTED HERE (#825, #929). There is
// no second membership or invitation plane on either seat; standing grants —
// including a share still on its way — are read live from the grant plane by
// `PersonGrants.tsx` through the share kit's own transport.

import type { VaultBinding } from "@centraid/blueprints/apps/people/types";

import type { Row } from "./people-model";
import { str } from "./people-model";

export interface ShareLinksInput {
  partyId: string;
  bindings: readonly Row[] | null;
}

export interface PersonShareLinks {
  vaults: VaultBinding[];
}

export function projectShareLinks(
  input: ShareLinksInput
): PersonShareLinks | null {
  const { bindings } = input;
  if (!bindings) return null;

  const vaults: VaultBinding[] = bindings.flatMap((binding) => {
    if (str(binding, "party_id") !== input.partyId) return [];
    if (str(binding, "revoked_at")) return [];
    const bindingId = str(binding, "binding_id");
    if (!bindingId) return [];
    return [
      {
        binding_id: bindingId,
        vault_id: str(binding, "vault_id") ?? "",
        linked_at: str(binding, "linked_at") ?? "",
      },
    ];
  });

  return { vaults };
}
