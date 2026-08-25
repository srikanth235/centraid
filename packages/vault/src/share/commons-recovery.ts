// Replica-export recovery for the Commons plane (#731).
//
// A commons grant has exactly ONE steward vault, and today its loss is
// terminal: members keep a complete replica forever and can do nothing with
// it. State shipping already gave every member the whole closure — the only
// missing piece is a ceremony that says "this group's steward is gone; I will
// found a new one from what I hold."
//
// This is deliberately a CEREMONY, never automatic:
//   * the old grant is SUPERSEDED, not deleted — its ops, receipts and
//     projected rows stay exactly where they are, and only its sync stops;
//   * the successor starts a fresh genesis chain at sequence 0, seeded from
//     the local closure, because the old chain's authority (the old steward's
//     key) is precisely what is unavailable;
//   * every other member is INVITED. Consent is never fabricated on another
//     vault's behalf — the successor's roster mirrors the old one, but each
//     seat must accept it like any other invitation;
//   * it refuses when this seat is parked on a named divergence fault (never
//     re-found from state you could not verify) and when this seat is already
//     the steward (there is nothing to recover from).

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";
import type { ShareableItemType } from "./closure.js";
import {
  commonsStateDigest,
  readCommonsChainHead,
  readCommonsVerified,
} from "./commons-chain.js";
import { commonsSeats } from "./commons-lifecycle.js";
import {
  commonsClosure,
  compileCommons,
  createCommonsGrant,
  readCommonsGrant,
} from "./commons.js";
import type { CommonsCapability, CommonsMemberInput } from "./commons.js";
import type { ShareVaultRef } from "./placement.js";

export interface RecoverCommonsFromReplicaInput {
  /** The local member vault holding the replica. It becomes the new steward. */
  seat: ShareVaultRef;
  /** Gateway id of `seat` — the successor grant's steward vault. */
  localVaultId: string;
  /** The grant whose steward is gone. */
  grantId: string;
  /** Free text stored as lineage; defaults to a steward-absence note. */
  reason?: string;
  now: string;
}

export type CommonsRecoveryRefusal =
  /** This vault already stewards the grant; absence recovery is meaningless. */
  | "already-steward"
  /** The seat is parked on a named history/digest fault. */
  | "parked-on-fault"
  /** The grant is revoked/superseded — there is nothing live to re-found. */
  | "grant-not-live"
  /** No projected container for the grant in this vault: no replica to export. */
  | "no-local-replica";

export interface CommonsRecoveryLineage {
  supersededGrantId: string;
  oldStewardPartyId: string;
  sourceSequence: number;
  sourceChainHeadHash: string;
  sourceVerifiedSequence: number;
  sourceStateDigest: string;
  reason: string;
  recoveredAt: string;
}

export type CommonsRecoveryResult =
  | {
      state: "recovered";
      grantId: string;
      circleId: string;
      containerType: ShareableItemType;
      containerId: string;
      /** Roster seats that must still accept the successor invitation. */
      invitedPartyIds: readonly string[];
      lineage: CommonsRecoveryLineage;
      /** True when a prior attempt had already re-founded this grant. */
      replayed: boolean;
    }
  | { state: "refused"; reason: CommonsRecoveryRefusal };

interface RosterSeat {
  partyId: string;
  capability: CommonsCapability;
}

function localOwnerPartyId(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string } | undefined;
  if (!row) throw new Error("commons recovery needs a bootstrapped vault");
  return row.owner_party_id;
}

/** The named divergence fault this seat parked on, if any. Read straight from
 *  the contact table rather than through the sync module, so recovery has no
 *  dependency on the pull path being loaded. */
function parkedFault(
  db: DatabaseSync,
  grantId: string,
  memberVaultId: string
): string | undefined {
  const row = db
    .prepare(
      `SELECT fault FROM share_commons_steward_contact
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .get(grantId, memberVaultId) as { fault: string | null } | undefined;
  return row?.fault ?? undefined;
}

/**
 * The replica's own row id for the grant's container. Projection assigns
 * audience-local ids, so the grant's `container_id` (the ORIGIN's id) is not
 * necessarily addressable here; `share_commons_lineage` is the mapping.
 */
function localContainerId(
  db: DatabaseSync,
  grantId: string,
  containerType: string,
  originContainerId: string
): string | undefined {
  const mapped = db
    .prepare(
      `SELECT item_id FROM share_commons_lineage
        WHERE grant_id = ? AND item_type = ? AND origin_item_id = ?`
    )
    .get(grantId, containerType, originContainerId) as
    | { item_id: string }
    | undefined;
  return mapped?.item_id;
}

function roster(
  db: DatabaseSync,
  grantId: string,
  circleId: string
): RosterSeat[] {
  return (
    (
      db
        .prepare(
          `SELECT m.party_id, m.capability, s.status
           FROM social_circle_member m
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = m.party_id
          WHERE m.circle_id = ?
          ORDER BY m.added_at, m.member_id`
        )
        .all(grantId, circleId) as {
        party_id: string;
        capability: CommonsCapability;
        status: "current" | "invited" | "refused";
      }[]
    )
      // A seat that already refused the old grant is not carried forward: the
      // successor mirrors the roster, not a wish list.
      .filter((seat) => seat.status !== "refused")
      .map((seat) => ({ partyId: seat.party_id, capability: seat.capability }))
  );
}

/** Insert the successor's own circle — owned by THIS vault's owner, so the
 *  successor grant has an authority of its own rather than borrowing the
 *  projected circle whose owner just disappeared. */
function foundCircle(input: {
  db: DatabaseSync;
  ownerPartyId: string;
  name: string;
  seats: readonly RosterSeat[];
  now: string;
}): string {
  const circleId = uuidv7();
  input.db.exec("BEGIN IMMEDIATE");
  try {
    input.db
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES (?, ?, ?, 'custom')`
      )
      .run(circleId, input.ownerPartyId, input.name);
    const member = input.db.prepare(
      `INSERT INTO social_circle_member
         (member_id, circle_id, party_id, added_at, capability)
       VALUES (?, ?, ?, ?, ?)`
    );
    // The founder always writes; every other seat keeps the capability the
    // superseded grant gave it.
    member.run(uuidv7(), circleId, input.ownerPartyId, input.now, "read+write");
    for (const seat of input.seats) {
      if (seat.partyId === input.ownerPartyId) continue;
      member.run(uuidv7(), circleId, seat.partyId, input.now, seat.capability);
    }
    input.db.exec("COMMIT");
  } catch (error) {
    input.db.exec("ROLLBACK");
    throw error;
  }
  return circleId;
}

/** A successor this ceremony already created — either recorded in the
 *  supersession table (the normal path) or discoverable as a live grant this
 *  vault stewards over the same replica (a retry after a mid-ceremony crash). */
function existingSuccessor(input: {
  db: DatabaseSync;
  oldGrantId: string;
  ownerPartyId: string;
  containerType: string;
  containerId: string;
}): { grantId: string; circleId: string } | undefined {
  const recorded = input.db
    .prepare(
      `SELECT new_grant_id, new_circle_id FROM share_commons_supersession
        WHERE old_grant_id = ?`
    )
    .get(input.oldGrantId) as
    | { new_grant_id: string; new_circle_id: string }
    | undefined;
  if (recorded)
    return { grantId: recorded.new_grant_id, circleId: recorded.new_circle_id };
  const orphan = input.db
    .prepare(
      `SELECT grant_id, circle_id FROM share_circle_grant
        WHERE plane = 'commons' AND container_type = ? AND container_id = ?
          AND steward_party_id = ? AND revoked_at IS NULL AND grant_id <> ?`
    )
    .get(
      input.containerType,
      input.containerId,
      input.ownerPartyId,
      input.oldGrantId
    ) as { grant_id: string; circle_id: string } | undefined;
  return orphan
    ? { grantId: orphan.grant_id, circleId: orphan.circle_id }
    : undefined;
}

function writeLineage(input: {
  db: DatabaseSync;
  oldGrantId: string;
  newGrantId: string;
  newCircleId: string;
  oldStewardPartyId: string;
  newStewardPartyId: string;
  newStewardVaultId: string;
  containerType: string;
  oldContainerId: string;
  newContainerId: string;
  lineage: CommonsRecoveryLineage;
}): void {
  input.db
    .prepare(
      `INSERT INTO share_commons_supersession
         (old_grant_id, new_grant_id, new_circle_id, old_steward_party_id,
          new_steward_party_id, new_steward_vault_id, container_type,
          old_container_id, new_container_id, source_sequence,
          source_chain_head_hash, source_verified_sequence,
          source_state_digest, reason, recovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(old_grant_id) DO NOTHING`
    )
    .run(
      input.oldGrantId,
      input.newGrantId,
      input.newCircleId,
      input.oldStewardPartyId,
      input.newStewardPartyId,
      input.newStewardVaultId,
      input.containerType,
      input.oldContainerId,
      input.newContainerId,
      input.lineage.sourceSequence,
      input.lineage.sourceChainHeadHash,
      input.lineage.sourceVerifiedSequence,
      input.lineage.sourceStateDigest,
      input.lineage.reason,
      input.lineage.recoveredAt
    );
  // Superseded, not deleted: the row, its ops, its receipts and every
  // projected domain row survive. Setting `revoked_at` is what stops the
  // sweep from pulling a steward that will never answer again.
  input.db
    .prepare(
      `UPDATE share_circle_grant SET revoked_at = ?
        WHERE grant_id = ? AND revoked_at IS NULL`
    )
    .run(input.lineage.recoveredAt, input.oldGrantId);
}

/**
 * Re-found a commons from this vault's replica. Idempotent under retry: a
 * second call returns the successor the first one created, and never mints a
 * second grant.
 */
export function recoverCommonsFromReplica(
  input: RecoverCommonsFromReplicaInput
): CommonsRecoveryResult {
  const db = input.seat.vault;
  const grant = readCommonsGrant(db, input.grantId);
  const ownerPartyId = localOwnerPartyId(db);
  if (grant.stewardPartyId === ownerPartyId)
    return { state: "refused", reason: "already-steward" };
  if (parkedFault(db, input.grantId, input.localVaultId))
    return { state: "refused", reason: "parked-on-fault" };
  const containerId = localContainerId(
    db,
    input.grantId,
    grant.containerType,
    grant.containerId
  );
  if (!containerId) return { state: "refused", reason: "no-local-replica" };
  const already = existingSuccessor({
    db,
    oldGrantId: input.grantId,
    ownerPartyId,
    containerType: grant.containerType,
    containerId,
  });
  if (!already && grant.revokedAt)
    return { state: "refused", reason: "grant-not-live" };
  const seats = roster(db, input.grantId, grant.circleId);
  const chainHead = readCommonsChainHead(db, input.grantId);
  const verified = readCommonsVerified(db, input.grantId);
  const circleId =
    already?.circleId ??
    foundCircle({
      db,
      ownerPartyId,
      name: `recovered:${grant.containerType}:${containerId}`,
      seats,
      now: input.now,
    });
  const successor = already
    ? readCommonsGrant(db, already.grantId)
    : createCommonsGrant({
        origin: db,
        ownerPartyId,
        ownerVaultId: input.localVaultId,
        ownerVault: input.seat,
        circleId,
        containerType: grant.containerType,
        containerId,
        // No `vaultId` on any other seat: that field is what marks a member
        // "current" at creation, and consent is theirs to give, not ours to
        // assume. Everyone else starts INVITED.
        members: seats
          .filter((seat) => seat.partyId !== ownerPartyId)
          .map<CommonsMemberInput>((seat) => ({
            partyId: seat.partyId,
            capability: seat.capability,
          })),
        departurePolicy: grant.departurePolicy,
        ...(grant.maxSizeBytes === undefined
          ? {}
          : { maxSizeBytes: grant.maxSizeBytes }),
        now: input.now,
      });
  // Seed the successor's own steward seat: cursor, roster and the lineage row
  // that ties the replica's container to the new grant. The closure is
  // unchanged bytes — the successor simply starts at sequence 0 over it.
  compileCommons({
    steward: input.seat,
    stewardVaultId: input.localVaultId,
    grantId: successor.grantId,
    seats: commonsSeats({
      steward: db,
      grantId: successor.grantId,
      stewardVaultId: input.localVaultId,
      vaultFor: (vaultId) =>
        vaultId === input.localVaultId ? input.seat : undefined,
    }),
    now: input.now,
  });
  const lineage: CommonsRecoveryLineage = {
    supersededGrantId: input.grantId,
    oldStewardPartyId: grant.stewardPartyId,
    sourceSequence: grant.lastSequence,
    sourceChainHeadHash: chainHead.hash,
    sourceVerifiedSequence: verified?.sequence ?? 0,
    sourceStateDigest: commonsStateDigest(
      commonsClosure(db, input.localVaultId, successor)
    ),
    reason: input.reason ?? "steward absent",
    recoveredAt: input.now,
  };
  writeLineage({
    db,
    oldGrantId: input.grantId,
    newGrantId: successor.grantId,
    newCircleId: circleId,
    oldStewardPartyId: grant.stewardPartyId,
    newStewardPartyId: ownerPartyId,
    newStewardVaultId: input.localVaultId,
    containerType: grant.containerType,
    oldContainerId: grant.containerId,
    newContainerId: containerId,
    lineage,
  });
  return {
    state: "recovered",
    grantId: successor.grantId,
    circleId,
    containerType: grant.containerType,
    containerId,
    invitedPartyIds: seats
      .filter((seat) => seat.partyId !== ownerPartyId)
      .map((seat) => seat.partyId),
    lineage: readCommonsRecoveryLineage(db, input.grantId) ?? lineage,
    replayed: already !== undefined,
  };
}

/** The recorded explanation of where a superseded grant's successor came from. */
export function readCommonsRecoveryLineage(
  db: DatabaseSync,
  oldGrantId: string
): CommonsRecoveryLineage | undefined {
  const row = db
    .prepare(
      `SELECT old_grant_id, old_steward_party_id, source_sequence,
              source_chain_head_hash, source_verified_sequence,
              source_state_digest, reason, recovered_at
         FROM share_commons_supersession WHERE old_grant_id = ?`
    )
    .get(oldGrantId) as
    | {
        old_grant_id: string;
        old_steward_party_id: string;
        source_sequence: number;
        source_chain_head_hash: string;
        source_verified_sequence: number;
        source_state_digest: string;
        reason: string;
        recovered_at: string;
      }
    | undefined;
  return row
    ? {
        supersededGrantId: row.old_grant_id,
        oldStewardPartyId: row.old_steward_party_id,
        sourceSequence: row.source_sequence,
        sourceChainHeadHash: row.source_chain_head_hash,
        sourceVerifiedSequence: row.source_verified_sequence,
        sourceStateDigest: row.source_state_digest,
        reason: row.reason,
        recoveredAt: row.recovered_at,
      }
    : undefined;
}
