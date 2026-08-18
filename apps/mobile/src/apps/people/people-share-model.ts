// The sharing plane for one person, split from `people-model.ts` when that
// file crossed the repo's 625-line ceiling — same contract, own module: the
// projection mirrors `queries/_shared.ts` `readPersonShareLinks` over the
// replica's own tables, and the caller hands null row sets for reads that
// failed; ANY failed read nulls the whole answer — the plane is one story,
// and half of it would read as "nothing is shared".

import type {
  PendingInvite,
  SharedContainer,
  VaultBinding,
} from "@centraid/blueprints/apps/people/types";

import type { Row } from "./people-model";
import { str } from "./people-model";

export interface ShareLinksInput {
  partyId: string;
  bindings: readonly Row[] | null;
  memberships: readonly Row[] | null;
  grants: readonly Row[] | null;
  memberStates: readonly Row[] | null;
  invitations: readonly Row[] | null;
}

export interface PersonShareLinks {
  vaults: VaultBinding[];
  pending_invites: PendingInvite[];
  shared_with_them: SharedContainer[];
}

export function projectShareLinks(
  input: ShareLinksInput
): PersonShareLinks | null {
  const { bindings, memberships, grants, memberStates, invitations } = input;
  if (!bindings || !memberships || !grants || !memberStates || !invitations)
    return null;

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

  const circleIds = new Set<string>();
  const capabilityByCircle = new Map<string, "read" | "read+write">();
  for (const membership of memberships) {
    if (str(membership, "party_id") !== input.partyId) continue;
    const circle = str(membership, "circle_id");
    if (!circle) continue;
    circleIds.add(circle);
    capabilityByCircle.set(
      circle,
      str(membership, "capability") === "read+write" ? "read+write" : "read"
    );
  }
  const stateByGrant = new Map<string, Row>();
  for (const state of memberStates) {
    if (str(state, "party_id") !== input.partyId) continue;
    const grant = str(state, "grant_id");
    if (grant) stateByGrant.set(grant, state);
  }
  const labelByGrant = new Map<string, string | null>();
  for (const invitation of theirInvitations) {
    const grant = str(invitation, "grant_id");
    if (grant) labelByGrant.set(grant, str(invitation, "container_label"));
  }

  const shared: SharedContainer[] = grants.flatMap((grant) => {
    const circle = str(grant, "circle_id");
    if (!circle || !circleIds.has(circle)) return [];
    if (str(grant, "revoked_at")) return [];
    const grantId = str(grant, "grant_id");
    if (!grantId) return [];
    const state = stateByGrant.get(grantId);
    if (!state) return [];
    const status = str(state, "status");
    return [
      {
        grant_id: grantId,
        container_type: str(grant, "container_type") ?? "",
        container_id: str(grant, "container_id") ?? "",
        container_label: labelByGrant.get(grantId) ?? null,
        capability: capabilityByCircle.get(circle) ?? "read",
        status:
          status === "invited" || status === "refused" ? status : "current",
        since: str(state, "accepted_at") ?? str(grant, "created_at") ?? "",
      },
    ];
  });

  return { vaults, pending_invites: pending, shared_with_them: shared };
}
