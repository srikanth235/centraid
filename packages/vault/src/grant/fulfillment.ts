/*
 * The grant plane's FULFILLMENT ENGINE (#825). The store above holds the
 * MEANING of a share; this holds the act of keeping it true.
 *
 * View is ORIGIN-AUTHORITATIVE RE-PROJECTION, never a merge (ruling G-view):
 * every pass re-reads the subject's closure from the origin and REPLACES the
 * audience's copy. The projector dedupes by content hash and row id, which is
 * right for a one-time placement and wrong for a standing grant, so the prior
 * projection is scrubbed first — the same shape `compileCommons` uses. Container
 * grants are MEMBERSHIP, NOT SNAPSHOT (ruling G-membership): an item added to a
 * granted album or folder is inside the closure the next pass reads.
 *
 * Scrub and re-project are ONE transaction on the audience vault. A crash
 * between them would leave the audience holding nothing while the grant still
 * stands — the one failure this engine must not be able to produce.
 *
 * Revocation is PROPAGATION, not erasure-at-a-distance (ruling G-revoke). A
 * reachable audience has the projection HARD-DELETED, no tombstone, and the
 * fulfillment row moves to `removed`; an unreachable one stops at
 * `remove_sent`, the honest end of what a sovereign system can say. No amount
 * of waiting turns that into `removed`.
 *
 * Nothing here reads a clock: every timestamp is the caller's, so a pass
 * replayed from a queue records when the WORK was decided.
 */

import type { DatabaseSync } from "node:sqlite";

import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { placeBlob } from "../share/blobs.js";
import type { ProjectedItem, WireClosure } from "../share/closure.js";
import {
  COMMONS_DEFAULT_MAX_SIZE_BYTES,
  commonsClosureSizeBytes,
} from "../share/commons.js";
import type { ShareVaultRef } from "../share/placement.js";
import { unshareFromVault } from "../share/placement.js";
import { projectShareClosure } from "../share/project-closure.js";
import { readShareClosure } from "../share/read-closure.js";
import { channelForParty } from "./channel.js";
import {
  mintGrantInvitation,
  withdrawGrantInvitations,
} from "./fulfillment-invite.js";
import type { ShareFulfillmentState, ShareGrantRecord } from "./grant-store.js";
import {
  ensureFulfillment,
  listFulfillment,
  readShareGrant,
  resolveAudienceParties,
  setFulfillmentState,
} from "./grant-store.js";

/**
 * A grant's subject exceeds its declared ceiling. Mirrors `CommonsMaxSizeError`
 * deliberately: the grant plane adds no SECOND budget (docs/decisions.md,
 * "Sharing v1") and fails the same way — before anything is placed.
 */
export class ShareGrantMaxSizeError extends Error {
  constructor(
    readonly grantId: string,
    readonly currentSizeBytes: number,
    readonly maxSizeBytes: number
  ) {
    super(
      `share grant ${grantId} is ${currentSizeBytes} bytes, above its ${maxSizeBytes} byte maximum`
    );
    this.name = "ShareGrantMaxSizeError";
  }
}

export interface GrantFulfillmentStep {
  partyId: string;
  state: ShareFulfillmentState;
  /** The audience vault this step addressed, when one is known at all. */
  peerVaultId?: string;
  /** Why the step stopped. Absent when it simply succeeded. */
  detail?: string;
  projected?: readonly ProjectedItem[];
  invitationId?: string;
  /** Bearer token, returned ONCE, for a party with no vault to address. */
  claimToken?: string;
}

export interface GrantFulfillmentResult {
  grantId: string;
  /** One step per party the audience resolves to, in roster order. */
  steps: readonly GrantFulfillmentStep[];
}

export interface FulfillShareGrantInput {
  /** Written only for fulfillment state. */
  origin: ShareVaultRef;
  /** Carried as provenance and steward id. */
  originVaultId: string;
  grantId: string;
  /**
   * The audience vault this host can write into right now, or `undefined`.
   * Absence is a fact about REACH, never about the grant.
   */
  seatFor: (vaultId: string) => ShareVaultRef | undefined;
  subjectLabel?: string;
  now: string;
}

function priorProjection(
  audience: DatabaseSync,
  originVaultId: string,
  grant: ShareGrantRecord
): string | undefined {
  const row = audience
    .prepare(
      `SELECT item_id FROM core_share_origin
        WHERE item_type = ? AND origin_vault_id = ? AND origin_item_id = ?`
    )
    .get(grant.subjectType, originVaultId, grant.subjectId) as
    | { item_id: string }
    | undefined;
  return row?.item_id;
}

/**
 * Replace the audience's copy with the origin's current one. Bytes go first (a
 * hardlink is idempotent and independent of the rows), then scrub + project
 * inside ONE audience transaction.
 */
function reproject(input: {
  origin: ShareVaultRef;
  originVaultId: string;
  seat: ShareVaultRef;
  closure: WireClosure;
  grant: ShareGrantRecord;
  now: string;
}): readonly ProjectedItem[] {
  for (const blob of input.closure.blobs)
    placeBlob(input.origin.blobs.local, input.seat.blobs.local, blob.sha256);
  const audience = input.seat.vault;
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT grant_reproject" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(audience);
    const prior = priorProjection(audience, input.originVaultId, input.grant);
    if (prior !== undefined)
      unshareFromVault({
        audience: input.seat,
        itemType: input.grant.subjectType,
        itemId: prior,
      });
    const projection = projectShareClosure(audience, input.closure, {
      sharedBy: `grant:${input.grant.grantId}`,
      now: () => Date.parse(input.now),
      ...(input.origin.sealKey && input.seat.sealKey
        ? {
            keys: {
              origin: input.origin.sealKey,
              audience: input.seat.sealKey,
            },
          }
        : {}),
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE grant_reproject" : "COMMIT");
    return projection.items;
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO grant_reproject" : "ROLLBACK");
    if (nested) audience.exec("RELEASE grant_reproject");
    throw error;
  }
}

/**
 * Read the subject once for the whole pass and refuse it over the ceiling. Lazy
 * on purpose: a grant whose whole audience is still `awaiting_channel` never
 * walks the closure at all.
 */
function subjectClosure(input: {
  origin: ShareVaultRef;
  originVaultId: string;
  grant: ShareGrantRecord;
}): WireClosure {
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.originVaultId,
    itemType: input.grant.subjectType,
    itemIds: [input.grant.subjectId],
    // An audience is another person by construction — a grant is never made to
    // oneself — so the origin's own media.location policy applies.
    crossOwner: true,
  });
  const sizeBytes = commonsClosureSizeBytes(closure);
  const ceiling = input.grant.maxSizeBytes ?? COMMONS_DEFAULT_MAX_SIZE_BYTES;
  if (sizeBytes > ceiling)
    throw new ShareGrantMaxSizeError(input.grant.grantId, sizeBytes, ceiling);
  return closure;
}

function park(input: {
  origin: ShareVaultRef;
  originVaultId: string;
  grant: ShareGrantRecord;
  partyId: string;
  peerVaultId?: string;
  subjectLabel?: string;
  sizeBytes: number;
  now: string;
}): GrantFulfillmentStep {
  const asked = mintGrantInvitation({
    origin: input.origin.vault,
    originVaultId: input.originVaultId,
    grant: input.grant,
    partyId: input.partyId,
    ...(input.peerVaultId === undefined
      ? {}
      : { peerVaultId: input.peerVaultId }),
    ...(input.subjectLabel === undefined
      ? {}
      : { containerLabel: input.subjectLabel }),
    currentSizeBytes: input.sizeBytes,
    now: input.now,
  });
  // A fulfillment row is keyed by peer vault, so a party with no vault id has
  // no row to write: absence there means "no channel yet", which is the truth.
  // The invitation is the record that the ask was made.
  if (input.peerVaultId !== undefined)
    ensureFulfillment(input.origin.vault, {
      grantId: input.grant.grantId,
      peerVaultId: input.peerVaultId,
      state: "awaiting_channel",
      updatedAt: input.now,
    });
  return {
    partyId: input.partyId,
    state: "awaiting_channel",
    ...(input.peerVaultId === undefined
      ? {}
      : { peerVaultId: input.peerVaultId }),
    invitationId: asked.invitation.invitationId,
    ...(asked.claimToken === undefined ? {} : { claimToken: asked.claimToken }),
  };
}

/**
 * Bring every audience vault of one standing grant up to the origin's current
 * truth. Safe to re-run on any change to the subject or roster: the pass IS a
 * re-projection, so running it twice is running it once. A circle audience
 * recompiles by construction — the roster is resolved every pass. Removing what
 * a departed member already holds is a REVOKE, not a roster edit; see
 * `propagateShareGrantRevocation`.
 */
export function fulfillShareGrant(
  input: FulfillShareGrantInput
): GrantFulfillmentResult {
  const db = input.origin.vault;
  const grant = readShareGrant(db, input.grantId);
  if (!grant) throw new Error(`share grant ${input.grantId} is not available`);
  if (grant.revokedAt !== null)
    throw new Error(
      `share grant ${input.grantId} is revoked; propagate its removal instead`
    );
  let loaded: WireClosure | undefined;
  const closure = (): WireClosure => {
    loaded ??= subjectClosure({
      origin: input.origin,
      originVaultId: input.originVaultId,
      grant,
    });
    return loaded;
  };
  // Read and size-check the subject before ANY state moves anywhere, so an
  // over-ceiling grant leaves no fulfillment row at all.
  closure();
  const steps: GrantFulfillmentStep[] = [];
  for (const partyId of resolveAudienceParties(db, grant.audience)) {
    // The owner is not their own audience: a circle containing the granter must
    // not project their own subject back into their own vault.
    if (partyId === grant.grantedBy) continue;
    const channel = channelForParty(db, partyId);
    if (!channel || channel.state !== "live" || channel.vaultId === undefined) {
      steps.push(
        park({
          origin: input.origin,
          originVaultId: input.originVaultId,
          grant,
          partyId,
          ...(channel?.vaultId === undefined
            ? {}
            : { peerVaultId: channel.vaultId }),
          ...(input.subjectLabel === undefined
            ? {}
            : { subjectLabel: input.subjectLabel }),
          sizeBytes: commonsClosureSizeBytes(closure()),
          now: input.now,
        })
      );
      continue;
    }
    const peerVaultId = channel.vaultId;
    const seat = input.seatFor(peerVaultId);
    if (!seat) {
      // The channel is open and the subject is on its way; this host just
      // cannot carry it now. `syncing` is the honest state, and the detail says
      // who could not be reached rather than inventing a failure.
      const detail = `peer vault ${peerVaultId} is not reachable from this host`;
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId,
        state: "syncing",
        updatedAt: input.now,
        detail,
      });
      steps.push({
        partyId,
        state: "syncing",
        peerVaultId,
        detail,
      });
      continue;
    }
    const wire = closure();
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId,
      state: "syncing",
      updatedAt: input.now,
    });
    const projected = reproject({
      origin: input.origin,
      originVaultId: input.originVaultId,
      seat,
      closure: wire,
      grant,
      now: input.now,
    });
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId,
      state: "delivered",
      updatedAt: input.now,
    });
    steps.push({ partyId, state: "delivered", peerVaultId, projected });
  }
  return { grantId: grant.grantId, steps };
}

export interface GrantRemovalStep {
  peerVaultId: string;
  state: ShareFulfillmentState;
  detail?: string;
  removed?: boolean;
}

export interface GrantRemovalResult {
  grantId: string;
  steps: readonly GrantRemovalStep[];
  /** Pending asks withdrawn because the grant they were made for is gone. */
  invitationsWithdrawn: number;
}

export interface PropagateShareGrantRevocationInput {
  origin: ShareVaultRef;
  originVaultId: string;
  grantId: string;
  seatFor: (vaultId: string) => ShareVaultRef | undefined;
  now: string;
}

/**
 * Carry a revocation out to every audience vault that was delivered to; the
 * store already dated it.
 *
 * `remove_sent` is TERMINAL ENOUGH: a peer that HELD the subject and cannot be
 * reached has been asked and has not answered, and the owner's copy says
 * exactly that. Nothing promotes it to `removed` on a timer — a delivered row
 * ends `removed` only by looking INSIDE the audience vault. A row that never
 * got past `awaiting_channel`/`syncing` ends `removed` with a detail saying
 * nothing had been delivered, never a fabricated "removal sent".
 */
export function propagateShareGrantRevocation(
  input: PropagateShareGrantRevocationInput
): GrantRemovalResult {
  const db = input.origin.vault;
  const grant = readShareGrant(db, input.grantId);
  if (!grant) throw new Error(`share grant ${input.grantId} is not available`);
  if (grant.revokedAt === null)
    throw new Error(
      `share grant ${input.grantId} still stands; revoke it before propagating`
    );
  const steps: GrantRemovalStep[] = [];
  for (const row of listFulfillment(db, grant.grantId)) {
    if (row.state === "removed") {
      steps.push({ peerVaultId: row.peerVaultId, state: "removed" });
      continue;
    }
    // Nothing was projected here, so nothing can be removed and nothing was
    // sent: the honest terminal state is `removed` with a detail saying so.
    //
    // The question is asked of `delivered_at`, the DURABLE MEMORY, not of the
    // live state (#846). Reading it off the state made a delivered grant whose
    // peer this host had merely lost reach for — `fulfillShareGrant` honestly
    // drops such a row to `syncing` — settle `removed` while the audience vault
    // still held the whole projection, telling the owner the share was gone
    // when it was not.
    if (row.deliveredAt === null) {
      const detail = "nothing had been delivered; there was nothing to remove";
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: row.peerVaultId,
        state: "removed",
        updatedAt: input.now,
        detail,
      });
      steps.push({
        peerVaultId: row.peerVaultId,
        state: "removed",
        detail,
        removed: false,
      });
      continue;
    }
    const seat = input.seatFor(row.peerVaultId);
    if (!seat) {
      const detail = `removal sent to ${row.peerVaultId}; the peer has not acknowledged it`;
      setFulfillmentState(db, {
        grantId: grant.grantId,
        peerVaultId: row.peerVaultId,
        state: "remove_sent",
        updatedAt: input.now,
        detail,
      });
      steps.push({
        peerVaultId: row.peerVaultId,
        state: "remove_sent",
        detail,
      });
      continue;
    }
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: row.peerVaultId,
      state: "remove_sent",
      updatedAt: input.now,
    });
    const prior = priorProjection(seat.vault, input.originVaultId, grant);
    // Hard delete, no tombstone (ruling G-revoke): the audience keeps no marker
    // row at all, and the bytes go to that vault's own orphan sweep. A delivered
    // row whose projection is already gone still ends `removed` — the peer
    // verifiably does not hold it.
    const removed =
      prior !== undefined &&
      unshareFromVault({
        audience: seat,
        itemType: grant.subjectType,
        itemId: prior,
      }).removed;
    setFulfillmentState(db, {
      grantId: grant.grantId,
      peerVaultId: row.peerVaultId,
      state: "removed",
      updatedAt: input.now,
      ...(removed
        ? {}
        : { detail: "the audience vault no longer held a projection" }),
    });
    steps.push({ peerVaultId: row.peerVaultId, state: "removed", removed });
  }
  return {
    grantId: grant.grantId,
    steps,
    invitationsWithdrawn: withdrawGrantInvitations(db, grant.grantId),
  };
}
