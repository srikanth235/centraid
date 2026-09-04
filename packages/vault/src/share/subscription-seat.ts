/*
 * AUDIENCE half of a subscription (#929). A frame lands through the door an
 * authored row takes — `projectShareClosure`, which runs `projection-ingest.ts`
 * per row — and the seat records, in the same transaction, WHICH SHAPE placed
 * each row and WHICH ORIGIN VERSION it stands for (`subscription-store.ts`).
 *
 * The lineage is what makes a purge safe: two grants over one photograph are
 * two lineage rows, so revoking one leaves the row the other still delivers.
 * `core_share_origin` cannot say that — it is keyed by the row and names one
 * sender — which is why removal reads that table and not this one.
 */

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import type { ProjectedItem, ShareableItemType } from "./closure.js";
import { shareableItemTypeOfEntity, shareOriginEntityType } from "./closure.js";
import { projectShareClosure } from "./project-closure.js";
import { deleteProjectedClosure } from "./removal.js";
import {
  applyShareShapeFields,
  planShareShapeIngest,
  shareShapeStructureDigest,
} from "./subscription-delta.js";
import type { ShareShapeFrame } from "./subscription-frame.js";
import { SHARE_SHAPE_FORMAT_VERSION } from "./subscription-frame.js";
import type { SubscriptionLineageRow } from "./subscription-store.js";
import {
  readSubscription,
  readSubscriptionLineage,
  recordSubscription,
} from "./subscription-store.js";

export interface IngestShareShapeResult {
  shapeId: string;
  /** Which path the change earned — the number a work-counter budget reads. */
  apply: "bootstrap" | "reproject" | "fields";
  /** The named items; empty on the field path, which re-projects nothing. */
  items: readonly ProjectedItem[];
  /** Rows an `UPDATE` touched on the field path. */
  fieldUpdates: number;
  /** Rows this shape claims, whether it placed them or deduped onto them. */
  lineageRows: number;
  cursor: { epoch: string; seq: number };
}

function versionKey(entity: string, rowId: string): string {
  return `${entity} ${rowId}`;
}

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
  shapeId: string
): ReleaseShapeRowsResult {
  const claims = readSubscriptionLineage(audience, shapeId).sort(
    (left, right) => removalRank(left) - removalRank(right)
  );
  audience
    .prepare("DELETE FROM share_subscription_lineage WHERE shape_id = ?")
    .run(shapeId);
  const stillClaimed = audience.prepare(
    `SELECT 1 AS present FROM share_subscription_lineage
      WHERE target_type = ? AND target_id = ? LIMIT 1`
  );
  const dropOrigin = audience.prepare(
    "DELETE FROM core_share_origin WHERE target_type = ? AND target_id = ?"
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
    dropOrigin.run(claim.targetType, claim.targetId);
    if (!outcome.removed) continue;
    removed += 1;
    for (const sha of outcome.shas) shas.add(sha);
  }
  return { removed, retained, shas: [...shas] };
}

/**
 * Claim every row the projection resolved — named items and the rows beneath
 * them — with the origin version each stands for. Read off the projection, not
 * off `core_share_origin`: that table is keyed by the row and names one sender,
 * so a SECOND grant over the same photograph would claim nothing.
 */
function claimShapeRows(
  audience: DatabaseSync,
  frame: ShareShapeFrame,
  rows: readonly ProjectedItem[],
  versions: ReadonlyMap<string, number>
): number {
  const claim = audience.prepare(
    `INSERT INTO share_subscription_lineage
       (shape_id, target_type, target_id, origin_item_id, origin_row_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (shape_id, target_type, target_id) DO UPDATE SET
       origin_item_id = excluded.origin_item_id,
       origin_row_version = excluded.origin_row_version`
  );
  let claimed = 0;
  for (const item of rows) {
    const entity = shareOriginEntityType(item.itemType);
    claim.run(
      frame.shapeId,
      entity,
      item.itemId,
      item.originItemId,
      versions.get(versionKey(entity, item.originItemId)) ?? 0
    );
    claimed += 1;
  }
  return claimed;
}

/**
 * ONE audience transaction, and only the writes the change earns.
 *
 * The seat holds nothing for the shape → bootstrap. Its structure moved →
 * release this shape's rows and re-project, which is the only path that can
 * follow an album's membership. Otherwise → one `UPDATE` per row whose origin
 * version moved, so a one-field edit is one change row and wakes the devices
 * that hold that row alone.
 */
export function ingestShareShape(
  audience: DatabaseSync,
  frame: ShareShapeFrame,
  options: { audienceVaultId: string; now: string }
): IngestShareShapeResult {
  if (frame.formatVersion !== SHARE_SHAPE_FORMAT_VERSION)
    throw new VaultShareError(
      `unsupported share shape format ${String(frame.formatVersion)}`
    );
  if (frame.audienceVaultId !== options.audienceVaultId)
    throw new VaultShareError(
      `share shape ${frame.shapeId} is addressed to ${frame.audienceVaultId}, not ${options.audienceVaultId}`
    );
  const versions = new Map(
    frame.rowVersions.map((row) => [
      versionKey(row.entity, row.rowId),
      row.version,
    ])
  );
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT ingest_share_shape" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(audience);
    const standing = readSubscription(
      audience,
      frame.shapeId,
      options.audienceVaultId
    );
    const plan = planShareShapeIngest({
      audience,
      frame,
      lineage: readSubscriptionLineage(audience, frame.shapeId),
      heldDigest:
        standing?.state === "subscribed" ? standing.structureDigest : null,
    });
    let items: readonly ProjectedItem[] = [];
    let applied = 0;
    let lineageRows = 0;
    if (plan.apply === "fields") {
      applied = applyShareShapeFields(audience, plan.updates);
      const bump = audience.prepare(
        `UPDATE share_subscription_lineage SET origin_row_version = ?
          WHERE shape_id = ? AND target_type = ? AND target_id = ?`
      );
      for (const update of plan.updates)
        bump.run(
          update.originRowVersion,
          frame.shapeId,
          update.entity,
          update.rowId
        );
      lineageRows = readSubscriptionLineage(audience, frame.shapeId).length;
    } else {
      if (plan.apply === "reproject") releaseShapeRows(audience, frame.shapeId);
      const projection = projectShareClosure(audience, frame.closure, {
        // SHAPE-KEYED, so provenance and lineage answer the same question.
        sharedBy: frame.shapeId,
        now: () => Date.parse(options.now),
      });
      items = projection.items;
      lineageRows = claimShapeRows(audience, frame, projection.rows, versions);
    }
    recordSubscription(audience, {
      shapeId: frame.shapeId,
      audienceVaultId: options.audienceVaultId,
      grantId: frame.grantId,
      originVaultId: frame.originVaultId,
      subjectType: frame.subjectType,
      cursor: frame.cursor,
      structureDigest: shareShapeStructureDigest(frame.closure),
      state: "subscribed",
      now: options.now,
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE ingest_share_shape" : "COMMIT");
    return {
      shapeId: frame.shapeId,
      apply: plan.apply,
      items,
      fieldUpdates: applied,
      lineageRows,
      cursor: frame.cursor,
    };
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO ingest_share_shape" : "ROLLBACK");
    if (nested) audience.exec("RELEASE ingest_share_shape");
    throw error;
  }
}

export interface PurgeShareShapeResult {
  shapeId: string;
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
  input: { shapeId: string; audienceVaultId: string; now: string }
): PurgeShareShapeResult {
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT purge_share_shape" : "BEGIN IMMEDIATE");
  try {
    const replicaCommit = beginReplicaCommit(audience);
    const standing = readSubscription(
      audience,
      input.shapeId,
      input.audienceVaultId
    );
    const released = releaseShapeRows(audience, input.shapeId);
    recordSubscription(audience, {
      shapeId: input.shapeId,
      audienceVaultId: input.audienceVaultId,
      grantId: standing?.grantId ?? input.shapeId,
      originVaultId: standing?.originVaultId ?? "",
      subjectType: standing?.subjectType ?? "",
      structureDigest: null,
      state: "removed",
      now: input.now,
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE purge_share_shape" : "COMMIT");
    return { shapeId: input.shapeId, ...released };
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO purge_share_shape" : "ROLLBACK");
    if (nested) audience.exec("RELEASE purge_share_shape");
    throw error;
  }
}
