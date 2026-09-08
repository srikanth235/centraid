/*
 * AUDIENCE half of a subscription (#929, rebuilt on the predicate #996 R10).
 *
 * TWO DOORS, and only these: a TAIL lands through `apply-outputs.ts`, and a
 * REVOCATION drops the grant's claims and deletes what nothing else claims.
 * The shape ingest that used to sit here — bootstrap, re-project or field
 * updates, decided by a structure digest — is gone with the composer that fed
 * it: the three outputs already say which rows entered, changed and left, so
 * there is nothing left for a digest to guess at.
 *
 * The lineage is what makes a purge safe: two grants over one photograph are
 * two lineage rows, so revoking one leaves the row the other still delivers.
 * A row-keyed provenance table could not say that — it names one sender — so
 * removal reads the grant's claims and nothing else.
 */

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import type { ApplyShareOutputsResult } from "./apply-outputs.js";
import { applyShareOutputs } from "./apply-outputs.js";
import type { ShareableItemType } from "./closure.js";
import { shareableItemTypeOfEntity } from "./closure.js";
import { deleteProjectedClosure } from "./removal.js";
import type { SubscriptionLineageRow } from "./subscription-store.js";
import {
  readSubscription,
  readSubscriptionLineage,
  recordSubscription,
} from "./subscription-store.js";
import type { ShareTailFrame } from "./subscription-tail.js";
import { SHARE_TAIL_FORMAT_VERSION } from "./subscription-tail.js";

export interface ReleaseShapeRowsResult {
  removed: number;
  retained: number;
  shas: string[];
}

/** Containers before their members, so a member's own delete is a no-op. */
const REMOVAL_ORDER: readonly ShareableItemType[] = [
  "core.collection",
  "docs.folder",
  "tally.group",
  "locker.item",
  "core.document",
  "media.asset",
  "core.content_item",
];

function removalRank(claim: SubscriptionLineageRow): number {
  const itemType = shareableItemTypeOfEntity(claim.targetType);
  const index = itemType ? REMOVAL_ORDER.indexOf(itemType) : -1;
  return index === -1 ? REMOVAL_ORDER.length : index;
}

/**
 * Drop this shape's claim and delete only what no OTHER live shape claims.
 * Inside the caller's transaction, so a re-projection scrub and a revocation
 * purge remove the same rows by the same rule — two grants over one photograph
 * are two lineage rows, and the second one keeps it.
 */
function releaseShapeRows(
  audience: DatabaseSync,
  authorityId: string
): ReleaseShapeRowsResult {
  const claims = readSubscriptionLineage(audience, authorityId).sort(
    (left, right) => removalRank(left) - removalRank(right)
  );
  audience
    .prepare("DELETE FROM share_subscription_lineage WHERE authority_id = ?")
    .run(authorityId);
  const stillClaimed = audience.prepare(
    `SELECT 1 AS present FROM share_subscription_lineage
      WHERE target_type = ? AND target_id = ? LIMIT 1`
  );
  const shas = new Set<string>();
  let removed = 0;
  let retained = 0;
  for (const claim of claims) {
    if (stillClaimed.get(claim.targetType, claim.targetId)) {
      retained += 1;
      continue;
    }
    const itemType = shareableItemTypeOfEntity(claim.targetType);
    if (!itemType) continue;
    const outcome = deleteProjectedClosure(audience, itemType, claim.targetId);
    if (!outcome.removed) continue;
    removed += 1;
    for (const sha of outcome.shas) shas.add(sha);
  }
  return { removed, retained, shas: [...shas] };
}

export interface PurgeShareShapeResult {
  authorityId: string;
  /** Rows deleted. A row another live shape still claims is not one. */
  removed: number;
  /** Rows released by this shape and kept for another. */
  retained: number;
  shas: string[];
}

/**
 * REVOCATION IS SHAPE REMOVAL. The seat drops its claim, deletes only what
 * nothing else claims, and records `removed` — which is the acknowledgement the
 * origin settles its own `remove_sent` row against.
 */
export function purgeShareShape(
  audience: DatabaseSync,
  input: { authorityId: string; audienceVaultId: string; now: string }
): PurgeShareShapeResult {
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT purge_share_shape" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(audience);
    const standing = readSubscription(
      audience,
      input.authorityId,
      input.audienceVaultId
    );
    const released = releaseShapeRows(audience, input.authorityId);
    recordSubscription(audience, {
      authorityId: input.authorityId,
      audienceVaultId: input.audienceVaultId,
      originVaultId: standing?.originVaultId ?? "",
      subjectType: standing?.subjectType ?? "",
      state: "removed",
      now: input.now,
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE purge_share_shape" : "COMMIT");
    return { authorityId: input.authorityId, ...released };
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO purge_share_shape" : "ROLLBACK");
    if (nested) audience.exec("RELEASE purge_share_shape");
    throw error;
  }
}

/**
 * INGEST A TAIL (#996, R10) — the audience's half of the predicate transport.
 *
 * One transaction, one replica commit, and only the writes the change earns:
 * the rows that entered, the rows that changed, the rows that left. No
 * re-projection, no digest, and no scrub-then-reinsert — which is what used to
 * wake every device that had ever seen the album for a one-field edit.
 *
 * The seat can ingest EITHER shape this wave: a frame through
 * `ingestShareShape` above, a tail through here. That is the transport
 * invariant in code — the replacement lands beside what it replaces, and the
 * frame path goes in the commit the convergence gate passes through this one.
 */
export function ingestShareTail(
  audience: DatabaseSync,
  frame: ShareTailFrame,
  options: { audienceVaultId: string; now: string }
): ApplyShareOutputsResult & { cursor: { epoch: string; seq: number } } {
  if (frame.formatVersion !== SHARE_TAIL_FORMAT_VERSION)
    throw new VaultShareError(
      `unsupported share tail format ${String(frame.formatVersion)}`
    );
  if (frame.audienceVaultId !== options.audienceVaultId)
    throw new VaultShareError(
      `share tail ${frame.authorityId} is addressed to ${frame.audienceVaultId}, not ${options.audienceVaultId}`
    );
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT ingest_share_tail" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(audience);
    const applied = applyShareOutputs(audience, frame.outputs, {
      originRowVersion: frame.originRowVersion,
    });
    recordSubscription(audience, {
      authorityId: frame.authorityId,
      audienceVaultId: options.audienceVaultId,
      originVaultId: frame.originVaultId,
      subjectType: frame.subjectType,
      // A DIVERGED SEAT DOES NOT ADVANCE ITS CURSOR (ruling G-view, #846). It
      // wrote a projected row behind the origin's back, so what it holds is no
      // longer what the origin served: keeping the cursor where it was makes
      // the origin's next pass a resend, and a resend overwrites the edit. The
      // pass that detected it still applies — it is not wrong, only short.
      ...(applied.diverged > 0 ? {} : { cursor: frame.outputs.cursor }),
      state: "subscribed",
      now: options.now,
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE ingest_share_tail" : "COMMIT");
    return { ...applied, cursor: frame.outputs.cursor };
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO ingest_share_tail" : "ROLLBACK");
    if (nested) audience.exec("RELEASE ingest_share_tail");
    throw error;
  }
}
