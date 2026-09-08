/*
 * ORIGIN half of a subscription (#929). A grant-keyed replica shape is composed
 * from `read-closure.ts`'s row source and handed to a transport — the loopback
 * when the audience is co-hosted, the peer replica route when it is not. The
 * origin is never written here, and it never reaches into an audience vault:
 * that reach is what confined cross-gateway sharing to the commons rail.
 *
 * Two things travel with the rows and nothing else does: the ORIGIN'S CURSOR,
 * so the seat can say how far it has ingested, and one ORIGIN ROW VERSION per
 * row, so a member's pending write settles against the version the origin
 * answered rather than the audience's own log.
 */

import { VaultShareError } from "../errors.js";
import { currentReplicaLogState } from "../replica/change-log.js";
import { isSealedValue, sealedColumnsOf } from "../schema/sealed.js";
import type { ShareableItemType, WireClosure, WireRow } from "./closure.js";
import type { ShareVaultRef } from "./placement.js";
import { readShareClosure } from "./read-closure.js";

/** The frame's own version. Pre-release: an unknown one is refused, not read. */
export const SHARE_SHAPE_FORMAT_VERSION = 1;

export interface ShareShapeRowVersion {
  /** Logical entity name, as `replica_change` keys it. */
  entity: string;
  /** The ORIGIN's row id. */
  rowId: string;
  version: number;
}

export interface ShareShapeFrame {
  formatVersion: number;
  /** Grant-keyed: `@share:<grantId>` (`@centraid/core/protocol`). */
  shapeId: string;
  grantId: string;
  originVaultId: string;
  audienceVaultId: string;
  subjectType: ShareableItemType;
  subjectId: string;
  /** The origin's replica cursor when the shape was composed. */
  cursor: { epoch: string; seq: number };
  closure: WireClosure;
  rowVersions: readonly ShareShapeRowVersion[];
  sizeBytes: number;
}

/**
 * THE ONE CEILING (#929). `share_delivery_config.max_size_bytes` is the
 * per-grant answer; this is the fail-closed default when a grant declares
 * none — generous yet finite, and the same number the three ceilings this
 * replaces all fell back to.
 */
export const SHARE_SHAPE_DEFAULT_MAX_SIZE_BYTES = 4 * 1024 * 1024 * 1024;

export class ShareShapeMaxSizeError extends Error {
  constructor(
    readonly grantId: string,
    readonly currentSizeBytes: number,
    readonly maxSizeBytes: number
  ) {
    super(
      `share grant ${grantId} is ${currentSizeBytes} bytes, above its ${maxSizeBytes} byte maximum`
    );
    this.name = "ShareShapeMaxSizeError";
  }
}

/** The rows on the wire plus the manifest's bytes — what the audience must
 *  hold. Blob sizes are deduped by sha: one photograph shared twice is one. */
export function shareShapeSizeBytes(closure: WireClosure): number {
  const blobSizes = new Map<string, number>();
  for (const blob of closure.blobs) blobSizes.set(blob.sha256, blob.size);
  return (
    Buffer.byteLength(JSON.stringify(closure), "utf8") +
    [...blobSizes.values()].reduce((sum, size) => sum + size, 0)
  );
}

/**
 * The sealed registry is a PIPELINE property, so a frame is checked against it
 * before it can leave: a sealed column must travel as ciphertext or not at all.
 * Plaintext here would make the subscription a seventh enforcement point that
 * silently is not one.
 */
function assertSealedColumnsStaySealed(closure: WireClosure): void {
  const check = (entity: string, rows: readonly WireRow[]): void => {
    const sealed = sealedColumnsOf(entity);
    if (sealed.length === 0) return;
    for (const row of rows)
      for (const column of sealed) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        if (typeof value === "string" && isSealedValue(value)) continue;
        throw new VaultShareError(
          `${entity}.${column} would leave the origin unsealed; a subscription carries ciphertext or nothing`
        );
      }
  };
  check("locker.item", closure.rows.lockerItems);
}

/** Every `(entity, rowId)` the closure carries, in `replica_change`'s names. */
function closureRowIds(closure: WireClosure): Map<string, string[]> {
  const byEntity = new Map<string, string[]>();
  const add = (entity: string, rowId: unknown): void => {
    if (typeof rowId !== "string" || rowId.length === 0) return;
    const held = byEntity.get(entity);
    if (held) held.push(rowId);
    else byEntity.set(entity, [rowId]);
  };
  for (const row of closure.rows.contentItems)
    add("core.content_item", row.content_id);
  for (const row of closure.rows.derivatives)
    add("core.content_derivative", row.derivative_id);
  for (const row of closure.rows.mediaAssets) add("media.asset", row.asset_id);
  for (const row of closure.rows.documents)
    add("core.document", row.document_id);
  for (const folder of closure.rows.docsFolders)
    for (const concept of folder.folders)
      add("core.concept", concept.concept_id);
  for (const collection of closure.rows.collections)
    add("core.collection", collection.row.collection_id);
  for (const row of closure.rows.lockerItems) add("locker.item", row.item_id);
  for (const group of closure.rows.tallyGroups)
    add("tally.group", group.group.group_id);
  return byEntity;
}

/**
 * The origin's current-epoch change sequence per row. Chunked, and one query
 * per entity rather than one per row: a shape is composed on the delivery loop,
 * not on a request path, but a per-row probe over an album is still O(album).
 */
function readOriginRowVersions(
  origin: ShareVaultRef,
  closure: WireClosure,
  epoch: string
): ShareShapeRowVersion[] {
  const versions: ShareShapeRowVersion[] = [];
  for (const [entity, rowIds] of closureRowIds(closure)) {
    for (let offset = 0; offset < rowIds.length; offset += 500) {
      const chunk = rowIds.slice(offset, offset + 500);
      const slots = chunk.map(() => "?").join(", ");
      const rows = origin.vault
        .prepare(
          `SELECT row_id, MAX(seq) AS seq FROM replica_change
            WHERE epoch = ? AND entity = ? AND row_id IN (${slots})
            GROUP BY row_id`
        )
        .all(epoch, entity, ...chunk) as {
        row_id: string;
        seq: number | null;
      }[];
      for (const row of rows)
        if (row.seq !== null)
          versions.push({ entity, rowId: row.row_id, version: row.seq });
    }
  }
  return versions;
}

export interface ComposeShareShapeInput {
  origin: ShareVaultRef;
  originVaultId: string;
  audienceVaultId: string;
  shapeId: string;
  grantId: string;
  subjectType: ShareableItemType;
  subjectId: string;
  /** `share_delivery_config`'s ceiling, or the vault-wide default. */
  maxSizeBytes?: number | null;
}

/** Read-only over the origin. Refuses over the ceiling before any transport. */
export function composeShareShape(
  input: ComposeShareShapeInput
): ShareShapeFrame {
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.originVaultId,
    itemType: input.subjectType,
    itemIds: [input.subjectId],
    // Never a grant to oneself: the origin's own media.location policy applies.
    crossOwner: true,
  });
  assertSealedColumnsStaySealed(closure);
  const sizeBytes = shareShapeSizeBytes(closure);
  const ceiling = input.maxSizeBytes ?? SHARE_SHAPE_DEFAULT_MAX_SIZE_BYTES;
  if (sizeBytes > ceiling)
    throw new ShareShapeMaxSizeError(input.grantId, sizeBytes, ceiling);
  const state = currentReplicaLogState(input.origin.vault);
  return {
    formatVersion: SHARE_SHAPE_FORMAT_VERSION,
    shapeId: input.shapeId,
    grantId: input.grantId,
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    cursor: state.watermark,
    closure,
    rowVersions: readOriginRowVersions(input.origin, closure, state.epoch),
    sizeBytes,
  };
}
