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
