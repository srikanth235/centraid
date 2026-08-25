/*
 * `awaiting_channel`, resolved (#825, ruling G-channel): a grant to a party
 * this vault never reached mints through the existing commons invitation
 * machinery, not a second table. The row lands in the ORIGIN vault, which is
 * what `channelForParty` reads to answer `invited`; `grant_id` is the SHARE
 * grant's, no foreign key.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  createCommonsClaimInvitation,
  queueCommonsInvitation,
} from "../share/commons-bootstrap.js";
import type { CommonsInvitationRecord } from "../share/commons-bootstrap.js";
import type { ShareGrantRecord } from "./grant-store.js";

export interface GrantInvitation {
  invitation: CommonsInvitationRecord;
  /** Returned ONCE: a token is a secret. */
  claimToken?: string;
}

export interface MintGrantInvitationInput {
  origin: DatabaseSync;
  originVaultId: string;
  grant: ShareGrantRecord;
  partyId: string;
  peerVaultId?: string;
  currentSizeBytes: number;
  containerLabel?: string;
  now: string;
}

function standingInvitation(
  db: DatabaseSync,
  grantId: string,
  partyId: string
): CommonsInvitationRecord | undefined {
  const row = db
    .prepare(
      `SELECT invitation_id, member_vault_id, capability, container_type,
              container_id, container_label, current_size_bytes, max_size_bytes,
              status, created_at, answered_at, steward_vault_id
         FROM share_commons_invitation
        WHERE grant_id = ? AND member_party_id = ? AND status = 'pending'`
    )
    .get(grantId, partyId) as
    | {
        invitation_id: string;
        member_vault_id: string | null;
        capability: CommonsInvitationRecord["capability"];
        container_type: string;
        container_id: string;
        container_label: string | null;
        current_size_bytes: number;
        max_size_bytes: number | null;
        status: CommonsInvitationRecord["status"];
        created_at: string;
        answered_at: string | null;
        steward_vault_id: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    invitationId: row.invitation_id,
    grantId,
    stewardVaultId: row.steward_vault_id,
    ...(row.member_vault_id ? { memberVaultId: row.member_vault_id } : {}),
    memberPartyId: partyId,
    capability: row.capability,
    containerType: row.container_type,
    containerId: row.container_id,
    ...(row.container_label ? { containerLabel: row.container_label } : {}),
    currentSizeBytes: row.current_size_bytes,
    ...(row.max_size_bytes === null
      ? {}
      : { maxSizeBytes: row.max_size_bytes }),
    status: row.status,
    createdAt: row.created_at,
    ...(row.answered_at ? { answeredAt: row.answered_at } : {}),
  };
}

/** Reports a standing ask: re-minting would rotate a live claim token. */
export function mintGrantInvitation(
  input: MintGrantInvitationInput
): GrantInvitation {
  const standing = standingInvitation(
    input.origin,
    input.grant.grantId,
    input.partyId
  );
  if (standing) return { invitation: standing };
  const invitation = {
    grantId: input.grant.grantId,
    stewardVaultId: input.originVaultId,
    memberPartyId: input.partyId,
    capability:
      input.grant.capability === "edit"
        ? ("read+write" as const)
        : ("read" as const),
    containerType: input.grant.subjectType,
    containerId: input.grant.subjectId,
    ...(input.containerLabel === undefined
      ? {}
      : { containerLabel: input.containerLabel }),
    currentSizeBytes: input.currentSizeBytes,
    ...(input.grant.maxSizeBytes === null
      ? {}
      : { maxSizeBytes: input.grant.maxSizeBytes }),
  };
  if (input.peerVaultId === undefined) {
    return createCommonsClaimInvitation({
      seat: input.origin,
      invitation,
      now: input.now,
    });
  }
  return {
    invitation: queueCommonsInvitation({
      seat: input.origin,
      invitation: { ...invitation, memberVaultId: input.peerVaultId },
      now: input.now,
    }),
  };
}

/** PENDING rows only, hard-deleted (G-revoke); ANSWERED ones survive. */
export function withdrawGrantInvitations(
  db: DatabaseSync,
  grantId: string
): number {
  return db
    .prepare(
      "DELETE FROM share_commons_invitation WHERE grant_id = ? AND status = 'pending'"
    )
    .run(grantId).changes as number;
}
