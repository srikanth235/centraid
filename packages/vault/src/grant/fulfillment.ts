/*
 * Grant fulfillment (#825): keep a share true. View is origin-authoritative re-projection, never a merge (G-view).
 * Scrub prior projection first (projector dedupes like a one-time placement). Container grants are membership, not snapshot (G-membership).
 * Scrub + re-project are ONE audience transaction — a crash between them must not leave the audience empty while the grant stands.
 * Revocation is propagation, not erasure-at-a-distance (G-revoke): reachable → hard-delete (no tombstone) + `removed`; unreachable stops at `remove_sent`. Waiting never promotes it.
 * No clock: timestamps are the caller's, so a queued replay records when the work was decided.
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

/** Subject exceeds its ceiling. Mirrors `CommonsMaxSizeError` — no second budget; fail before placing. */
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
  peerVaultId?: string;
  detail?: string;
  projected?: readonly ProjectedItem[];
  invitationId?: string;
  /** Bearer token, returned once, for a party with no vault to address. */
  claimToken?: string;
}

export interface GrantFulfillmentResult {
  grantId: string;
  steps: readonly GrantFulfillmentStep[];
}

export interface FulfillShareGrantInput {
  origin: ShareVaultRef;
  originVaultId: string;
  grantId: string;
  /** Audience vault this host can write now, or `undefined` — a fact about reach, never the grant. */
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

/** Replace the audience copy. Bytes first (hardlink is independent), then scrub + project in one audience txn. */
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

/** Read the subject once and refuse over the ceiling. Lazy: an all-`awaiting_channel` audience never walks the closure. */
function subjectClosure(input: {
  origin: ShareVaultRef;
  originVaultId: string;
  grant: ShareGrantRecord;
}): WireClosure {
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.originVaultId,
    itemType: input.grant.subjectType,
    itemIds: [input.grant.subjectId],
    // Grant is never to oneself — origin's own media.location policy applies.
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
  // Fulfillment is keyed by peer vault; no vault id means no row ("no channel yet"). The invitation records the ask.
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

/** Re-project every audience vault. Idempotent. A departed member's copy is a revoke, not a roster edit (`propagateShareGrantRevocation`). */
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
  // Size-check before any state moves — over-ceiling must leave no fulfillment row.
  closure();
  const steps: GrantFulfillmentStep[] = [];
  for (const partyId of resolveAudienceParties(db, grant.audience)) {
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
      // Channel open but this host cannot carry it now. `syncing` is honest — do not invent a failure.
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
 * Propagate revocation to every delivered audience. `remove_sent` is terminal enough — nothing promotes it to `removed` on a timer.
 * Delivered → `removed` only by looking inside the audience vault. Never-delivered ends `removed` with a "nothing delivered" detail, never a fabricated "removal sent".
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
    // Ask `delivered_at` (durable), not live state (#846): a lost-reach delivered row honestly sits in `syncing` and must not settle `removed` while the audience still holds it.
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
    // Hard delete, no tombstone (G-revoke). Bytes go to the audience's orphan sweep. Already-gone projection still ends `removed`.
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
