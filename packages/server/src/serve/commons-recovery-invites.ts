import {
  commonsCurrentSize,
  createCommonsClaimInvitation,
  listCommonsGrants,
  queueCommonsInvitation,
  readCommonsGrant,
} from "@centraid/vault";
import type { CommonsCapability, VaultDb } from "@centraid/vault";

export type CommonsInvitationDeliveryState =
  | "queued"
  | "delivered"
  | "claim"
  | "unreachable";

export interface CommonsInvitationDelivery {
  partyId: string;
  memberVaultId?: string;
  state: CommonsInvitationDeliveryState;
  claimToken?: string;
}

export interface DeliverCommonsRecoveryInvitationsInput {
  seat: VaultDb;
  stewardVaultId: string;
  grantId: string;
  vaultFor?: (vaultId: string) => VaultDb | undefined;
  invitePeer?: (input: {
    stewardVaultId: string;
    memberVaultId: string;
    grantId: string;
    memberPartyId: string;
    capability: CommonsCapability;
    containerType: string;
    containerId: string;
    containerLabel?: string;
    currentSizeBytes: number;
    maxSizeBytes?: number;
  }) => Promise<boolean>;
  now?: string;
}

function boundVaultId(seat: VaultDb, partyId: string): string | undefined {
  const row = seat.vault
    .prepare(
      `SELECT vault_id FROM share_party_vault_binding
        WHERE party_id = ? AND revoked_at IS NULL
        ORDER BY linked_at DESC LIMIT 1`
    )
    .get(partyId) as { vault_id: string } | undefined;
  return row?.vault_id;
}

export async function deliverCommonsRecoveryInvitations(
  input: DeliverCommonsRecoveryInvitationsInput
): Promise<CommonsInvitationDelivery[]> {
  const now = input.now ?? new Date().toISOString();
  const grant = readCommonsGrant(input.seat.vault, input.grantId);
  const view = listCommonsGrants(input.seat.vault).find(
    (entry) => entry.grant.grantId === input.grantId
  );
  const label = input.seat.vault
    .prepare("SELECT name FROM social_circle WHERE circle_id = ?")
    .get(grant.circleId) as { name: string | null } | undefined;
  const currentSizeBytes = commonsCurrentSize(
    input.seat.vault,
    input.stewardVaultId,
    input.grantId
  );
  const deliveries: CommonsInvitationDelivery[] = [];
  for (const member of view?.members ?? []) {
    if (member.status !== "invited") continue;
    const base = {
      grantId: input.grantId,
      stewardVaultId: input.stewardVaultId,
      memberPartyId: member.partyId,
      capability: member.capability,
      containerType: grant.containerType,
      containerId: grant.containerId,
      ...(label?.name ? { containerLabel: label.name } : {}),
      currentSizeBytes,
      ...(grant.maxSizeBytes === undefined
        ? {}
        : { maxSizeBytes: grant.maxSizeBytes }),
    };
    const memberVaultId = boundVaultId(input.seat, member.partyId);
    const cohosted = memberVaultId
      ? input.vaultFor?.(memberVaultId)
      : undefined;
    if (memberVaultId && cohosted) {
      queueCommonsInvitation({
        seat: cohosted.vault,
        invitation: { ...base, memberVaultId },
        now,
      });
      deliveries.push({
        partyId: member.partyId,
        memberVaultId,
        state: "queued",
      });
      continue;
    }
    if (memberVaultId && input.invitePeer) {
      // oxlint-disable-next-line no-await-in-loop -- roster order is the delivery order an operator reads back
      const pushed = await input.invitePeer({ ...base, memberVaultId });
      if (pushed) {
        deliveries.push({
          partyId: member.partyId,
          memberVaultId,
          state: "delivered",
        });
        continue;
      }
    }
    const claimed = createCommonsClaimInvitation({
      seat: input.seat.vault,
      invitation: base,
      now,
    });
    deliveries.push({
      partyId: member.partyId,
      ...(memberVaultId ? { memberVaultId } : {}),
      state: memberVaultId ? "unreachable" : "claim",
      claimToken: claimed.claimToken,
    });
  }
  return deliveries;
}
