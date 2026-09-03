// The sharing plane for one person, split from `people-model.ts` when that
// file crossed the repo's 625-line ceiling — same contract, own module: the
// projection mirrors `queries/_shared.ts` `readPersonShareLinks` over the
// replica's own tables, and the caller hands null row sets for reads that
// failed; ANY failed read nulls the whole answer — the plane is one story,
// and half of it would read as "nothing is shared".
//
// WHAT IS SHARED WITH THE PERSON IS NOT PROJECTED HERE (#825). There is no
// circle_grant × circle_member × commons_member_state projection on either
// seat; standing grants are read live from the grant plane by
// `PersonGrants.tsx` through the share kit's own transport.
import type {
  PendingInvite,
  VaultBinding,
} from "@centraid/blueprints/apps/people/types";

import type { Row } from "./people-model";
import { str } from "./people-model";

export interface ShareLinksInput {
  partyId: string;
  bindings: readonly Row[] | null;
  invitations: readonly Row[] | null;
}

export interface PersonShareLinks {
  vaults: VaultBinding[];
  pending_invites: PendingInvite[];
}

export function projectShareLinks(
  input: ShareLinksInput
): PersonShareLinks | null {
  const { bindings, invitations } = input;
  if (!bindings || !invitations) return null;

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

  const theirInvitations = invitations.filter(
    (row) => str(row, "member_party_id") === input.partyId
  );
  const pending: PendingInvite[] = theirInvitations.flatMap((row) => {
    if (str(row, "status") !== "pending") return [];
    const id = str(row, "invitation_id");
    if (!id) return [];
    return [
      {
        invitation_id: id,
        container_label: str(row, "container_label"),
        capability:
          str(row, "capability") === "read+write" ? "read+write" : "read",
        created_at: str(row, "created_at") ?? "",
      },
    ];
  });

  return { vaults, pending_invites: pending };
}
