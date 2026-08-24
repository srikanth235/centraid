/**
 * Successor-invitation DELIVERY for the steward-absence ceremony (#750).
 *
 * `recoverCommonsFromReplica` re-founds the group from a member's replica and
 * leaves every other seat INVITED — consent is never fabricated. Delivery is
 * part of the ceremony rather than a caller's follow-up: undelivered, it
 * produces a steward-of-one and the group stays dead.
 *
 * Delivery follows exactly the paths the ordinary create-a-commons route uses,
 * in this order per member seat:
 *
 *   1. CO-HOSTED — the member vault is mounted on this same gateway: queue the
 *      invitation straight onto its seat.
 *   2. LINKED PEER — an approved vault link already exists between the NEW
 *      steward and the member (true for N=2 always, and for any member already
 *      linked to the successor): push it over the peer plane.
 *   3. CLAIM TICKET — no link exists (the N≥3 case: the member's only link was
 *      to the vault that disappeared). The successor mints a one-time claim
 *      token bound to that party; the operator carries it out of band and the
 *      member redeems it after pairing with the new steward. This is
 *      old-steward-independent by construction — nothing in the claim path
 *      touches the lost vault — but it is NOT automatic, and the runbook
 *      (docs/recovery/commons-steward-loss.md) says so plainly.
 */

import {
  commonsCurrentSize,
  createCommonsClaimInvitation,
  listCommonsGrants,
  queueCommonsInvitation,
  readCommonsGrant,
} from "@centraid/vault";
import type { CommonsCapability, VaultDb } from "@centraid/vault";

export type CommonsInvitationDeliveryState =
  /** Written directly onto a co-hosted member seat. */
  | "queued"
  /** Accepted by the member's gateway over an existing vault link. */
  | "delivered"
  /** No link to the successor: a claim token the operator must carry. */
  | "claim"
  /** A link exists but the peer refused or could not be reached right now. */
  | "unreachable";

export interface CommonsInvitationDelivery {
  partyId: string;
  memberVaultId?: string;
  state: CommonsInvitationDeliveryState;
  /** Present only for `claim`; one-time, never logged or stored by callers. */
  claimToken?: string;
}

export interface DeliverCommonsRecoveryInvitationsInput {
  /** The successor's steward seat — the vault that ran the ceremony. */
  seat: VaultDb;
  stewardVaultId: string;
  /** The SUCCESSOR grant id returned by the ceremony. */
  grantId: string;
  /** Member vaults mounted on this same gateway. */
  vaultFor?: (vaultId: string) => VaultDb | undefined;
  /** Peer-plane push; returns false when no link/dial is available. */
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

/** The member vault this seat knows for a party, from its own bindings. The
 *  successor's roster is party-keyed; bindings are what turn a party into an
 *  address, and they survive the old steward because they were projected into
 *  this replica while it was still syncing. */
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
    // No link to the successor (or the link is down): mint the out-of-band
    // claim. Overwriting a previous claim for the same party is deliberate —
    // an undelivered ticket is not consent, and re-running the ceremony
    // should hand the operator a fresh one rather than a stale hash.
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
