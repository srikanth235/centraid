/*
 * `awaiting_channel`, resolved (#825, ruling G-channel). A grant to a
 * person this vault has never reached is not an error and not a queue: it is a
 * standing grant whose FIRST fulfillment step is asking that person for a
 * channel. The asking machinery already exists — `share_commons_invitation`
 * and its claim tokens (commons-bootstrap.ts) — so this module MINTS through
 * it rather than growing a second invitation table beside it.
 *
 * Two shapes, decided by what this vault knows about the party:
 *
 *   - a peer vault id is known (a severed binding, an earlier commons) →
 *     `queueCommonsInvitation`, addressed to that vault;
 *   - nothing is known → `createCommonsClaimInvitation`, whose bearer token is
 *     returned ONCE for an invite link and only ever stored as a hash.
 *
 * The row is written into the ORIGIN vault. That is deliberate: it is the
 * record that THIS vault has asked, and it is exactly the row
 * `channelForParty` reads to answer `invited`. Carrying the ask to the peer is
 * transport's job, not the engine's — the invitation stands whether or not a
 * packet has moved yet.
 *
 * `grant_id` on the minted row is the SHARE grant's id, never a commons
 * grant's. The column carries no foreign key precisely because the invitation
 * is consent metadata about a grant that may live in either plane.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  createCommonsClaimInvitation,
  queueCommonsInvitation,
} from "../share/commons-bootstrap.js";
import type { CommonsInvitationRecord } from "../share/commons-bootstrap.js";
import type { ShareGrantRecord } from "./grant-store.js";

/** A standing ask for a channel, plus the bearer token when one was minted. */
export interface GrantInvitation {
  invitation: CommonsInvitationRecord;
  /**
   * Returned ONCE, and only for a party with no known vault: the raw claim
   * token to put in an invite link. Absent when the invitation was addressed
   * to a vault this party is already known by, and absent when a standing
   * invitation was reported rather than minted — a token is a secret, never a
   * value a repeated read can hand out again.
   */
  claimToken?: string;
}

export interface MintGrantInvitationInput {
  /** The origin vault — the one doing the asking, and the one written. */
  origin: DatabaseSync;
  /** Gateway id of the origin vault, recorded as the invitation's steward. */
  originVaultId: string;
  grant: ShareGrantRecord;
  /** The person being asked. One of the audience's resolved parties. */
  partyId: string;
  /** The peer vault this party is known by, when this vault knows one. */
  peerVaultId?: string;
  /** Honest full-copy footprint of the subject, shown before acceptance. */
  currentSizeBytes: number;
  /** Human label for the subject, when the caller has one. */
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

/**
 * Ask a party for a channel on this grant's behalf, or report the ask already
 * standing. Idempotent by that report: a fulfillment pass runs on every change
 * to the grant's subject, and re-minting would rotate a live claim token out
 * from under an invite link the owner has already sent.
 */
export function mintGrantInvitation(
  input: MintGrantInvitationInput
): GrantInvitation {
  const standing = standingInvitation(
    input.origin,
    input.grant.grantId,
    input.partyId
  );
  if (standing) return { invitation: standing };
  // The commons vocabulary is the same decision in its own words: a `view`
  // grant is read, an `edit` grant is read+write. The invitation carries the
  // capability so the peer answers the grant it was actually offered.
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

/**
 * Withdraw the asks a revoked grant minted. Only PENDING rows go, and only
 * ones whose `grant_id` is this share grant's — a commons invitation's
 * lifecycle is owned by commons and is never touched from here.
 *
 * A hard delete, matching G-revoke's rule for the audience side: a question
 * that was never answered is not a decision worth keeping, and leaving it
 * standing would keep `channelForParty` reporting `invited` on behalf of a
 * grant that no longer exists. An ANSWERED invitation survives untouched — it
 * records what the peer decided, which the revoke does not undo.
 */
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
