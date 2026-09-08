// Audience half of a share (#726): one audience transaction. Origin is
// unreachable (`WireClosure` is JSON). Projected rows reuse the origin uuidv7.

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { CLOSURE_FORMAT_VERSION, shareOriginEntityType } from "./closure.js";
import type {
  ContentItemRow,
  DerivativeRow,
  DocumentRow,
  MediaAssetRow,
  ProjectedItem,
  ProjectResult,
  ShareableItemType,
  WireClosure,
  WireCollection,
  WireDocsFolder,
  WireItem,
} from "./closure.js";
import {
  ownerPartyId,
  projectLockerItem,
  projectTallyGroup,
} from "./project-household.js";
import { runProjectionIngest } from "./projection-ingest.js";
import { freeId, insert, nullableString } from "./sql.js";

type Projected = Map<string, ProjectedItem>;

// NUL as the separator, written as the `\0` ESCAPE and not as a raw byte: a
// raw NUL makes git treat this file as binary, so every diff of it reads
// "Binary files differ" and no reviewer can see the projection change (#916,
// audit F1). It stays NUL because no item type or id can contain one, so the
// composite key cannot be forged by a peer-supplied id.
function keyOf(itemType: ShareableItemType, itemId: string): string {
  return `${itemType}\0${itemId}`;
}

function record(
  into: Projected,
  itemType: ShareableItemType,
  originItemId: string,
  projection: { itemId: string; deduped: boolean; contentId?: string }
): void {
  into.set(keyOf(itemType, originItemId), {
    itemType,
    originItemId,
    ...projection,
  });
}

function contentOf(into: Projected, originContentId: string): string {
  const projection = into.get(keyOf("core.content_item", originContentId));
  if (!projection?.contentId)
    throw new VaultShareError(
      `incomplete share closure: core.content_item ${originContentId} is missing`
    );
  return projection.contentId;
}

function projectContentItems(
  audience: DatabaseSync,
  contentItems: readonly ContentItemRow[],
  into: Projected
): void {
  const bySha = audience.prepare(
    "SELECT content_id FROM core_content_item WHERE sha256 = ?"
  );
  const write = audience.prepare(
    `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, title, language,
        creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
  );
  for (const row of contentItems) {
    const existing = bySha.get(row.sha256) as
      | { content_id: string }
      | undefined;
    const contentId =
      existing?.content_id ??
      freeId(audience, "core_content_item", "content_id", row.content_id);
    if (!existing) {
      write.run(
        contentId,
        row.media_type,
        row.content_uri,
        row.sha256,
        row.byte_size,
        row.title,
        row.language,
        row.deleted_at,
        row.purge_at,
        row.created_at
      );
    }
    record(into, "core.content_item", row.content_id, {
      itemId: contentId,
      deduped: existing !== undefined,
      contentId,
    });
  }
}

function projectDerivatives(
  audience: DatabaseSync,
  derivatives: readonly DerivativeRow[],
  into: Projected
): void {
  const held = audience.prepare(
    "SELECT 1 AS present FROM core_content_derivative WHERE content_id = ? AND variant = ?"
  );
  const write = audience.prepare(
    `INSERT INTO core_content_derivative
       (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of derivatives) {
    const contentId = contentOf(into, row.content_id);
    if (held.get(contentId, row.variant)) continue;
    write.run(
      freeId(
        audience,
        "core_content_derivative",
        "derivative_id",
        row.derivative_id
      ),
      contentId,
      row.variant,
      row.sha256,
      row.media_type,
      row.byte_size,
      row.text_content,
      row.created_at
    );
  }
}

function projectMediaAssets(
  audience: DatabaseSync,
  assets: readonly MediaAssetRow[],
  into: Projected
): void {
  // Do not project `source_asset_id` (#711): it names an origin asset.
  const byContent = audience.prepare(
    "SELECT asset_id FROM media_asset WHERE content_id = ?"
  );
  const write = audience.prepare(
    `INSERT INTO media_asset
       (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id,
        place_id, camera_device_id, width, height, duration_s, exif_json,
        archived_at, deleted_at, purge_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of assets) {
    const contentId = contentOf(into, row.content_id);
    const existing = byContent.get(contentId) as
      | { asset_id: string }
      | undefined;
    if (existing) {
      record(into, "media.asset", row.asset_id, {
        itemId: existing.asset_id,
        deduped: true,
        contentId,
      });
      continue;
    }
    const assetId = freeId(audience, "media_asset", "asset_id", row.asset_id);
    write.run(
      assetId,
      contentId,
      row.kind,
      row.captured_at,
      row.tz_offset_min,
      row.capture_group_id,
      row.width,
      row.height,
      row.duration_s,
      row.exif_json,
      row.archived_at,
      row.deleted_at,
      row.purge_at
    );
    record(into, "media.asset", row.asset_id, {
      itemId: assetId,
      deduped: false,
      contentId,
    });
  }
}

function projectDocuments(
  audience: DatabaseSync,
  documents: readonly DocumentRow[],
  into: Projected
): void {
  for (const row of documents) {
    const contentId = contentOf(into, row.current_content_id);
    const held =
      (audience
        .prepare("SELECT document_id FROM core_document WHERE document_id = ?")
        .get(row.document_id) as { document_id: string } | undefined) ??
      (audience
        .prepare(
          `SELECT document_id FROM core_document
            WHERE current_content_id = ? AND title = ? LIMIT 1`
        )
        .get(contentId, row.title) as { document_id: string } | undefined);
    if (held) {
      record(into, "core.document", row.document_id, {
        itemId: held.document_id,
        deduped: true,
        contentId,
      });
      continue;
    }
    const documentId = freeId(
      audience,
      "core_document",
      "document_id",
      row.document_id
    );
    audience
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at,
            deleted_at, purge_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        documentId,
        row.title,
        contentId,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.purge_at
      );
    record(into, "core.document", row.document_id, {
      itemId: documentId,
      deduped: false,
      contentId,
    });
  }
}

function projectCollections(
  audience: DatabaseSync,
  collections: readonly WireCollection[],
  into: Projected
): void {
  for (const collection of collections) {
    const originId = String(collection.row.collection_id);
    const held = audience
      .prepare(
        "SELECT collection_id FROM core_collection WHERE collection_id = ?"
      )
      .get(originId) as { collection_id: string } | undefined;
    if (held) {
      record(into, "core.collection", originId, {
        itemId: held.collection_id,
        deduped: true,
      });
      continue;
    }
    const itemId = freeId(
      audience,
      "core_collection",
      "collection_id",
      originId
    );
    // Cover id is the audience-side content id (sha256 dedupe may remap it).
    const originCover = nullableString(collection.row.cover_content_id);
    const cover = originCover
      ? (into.get(keyOf("core.content_item", originCover))?.contentId ?? null)
      : null;
    insert(audience, "core_collection", {
      ...collection.row,
      collection_id: itemId,
      owner_party_id: ownerPartyId(audience),
      cover_content_id: cover,
      parent_collection_id: null,
    });
    for (const entry of collection.entries) {
      const targetType = String(entry.target_type) as ShareableItemType;
      const targetId = String(entry.target_id);
      const target = into.get(keyOf(targetType, targetId));
      if (!target)
        throw new VaultShareError(
          `incomplete share closure: collection entry ${targetType} ${targetId} is missing`
        );
      insert(audience, "core_collection_entry", {
        ...entry,
        entry_id: freeId(
          audience,
          "core_collection_entry",
          "entry_id",
          String(entry.entry_id)
        ),
        collection_id: itemId,
        target_id: target.itemId,
      });
    }
    record(into, "core.collection", originId, { itemId, deduped: false });
  }
}

function projectDocsFolders(
  audience: DatabaseSync,
  docsFolders: readonly WireDocsFolder[],
  into: Projected
): void {
  for (const folderClosure of docsFolders) {
    const originSchemeId = String(folderClosure.scheme.scheme_id);
    const schemeUri = String(folderClosure.scheme.uri);
    const heldScheme = audience
      .prepare("SELECT scheme_id FROM core_concept_scheme WHERE uri = ?")
      .get(schemeUri) as { scheme_id: string } | undefined;
    const schemeId =
      heldScheme?.scheme_id ??
      freeId(audience, "core_concept_scheme", "scheme_id", originSchemeId);
    if (!heldScheme) {
      insert(audience, "core_concept_scheme", {
        ...folderClosure.scheme,
        scheme_id: schemeId,
      });
    }

    for (const [index, folder] of folderClosure.folders.entries()) {
      const originId = String(folder.concept_id);
      const notation = String(folder.notation);
      const held = audience
        .prepare(
          "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?"
        )
        .get(schemeId, notation) as { concept_id: string } | undefined;
      const itemId =
        held?.concept_id ??
        freeId(audience, "core_concept", "concept_id", originId);
      if (!held) {
        const originParent = nullableString(folder.broader_concept_id);
        const projectedParent = originParent
          ? into.get(keyOf("docs.folder", originParent))?.itemId
          : undefined;
        insert(audience, "core_concept", {
          ...folder,
          concept_id: itemId,
          scheme_id: schemeId,
          broader_concept_id: index === 0 ? null : (projectedParent ?? null),
        });
      }
      record(into, "docs.folder", originId, {
        itemId,
        deduped: held !== undefined,
      });
    }

    for (const tag of folderClosure.tags) {
      const document = into.get(keyOf("core.document", String(tag.target_id)));
      const folder = into.get(keyOf("docs.folder", String(tag.concept_id)));
      if (!document || !folder)
        throw new VaultShareError(
          `incomplete Docs folder closure: tag ${String(tag.tag_id)} has no projected target`
        );
      const held = audience
        .prepare(
          `SELECT 1 AS present FROM core_tag
            WHERE target_type = 'core.document' AND target_id = ? AND concept_id = ?`
        )
        .get(document.itemId, folder.itemId);
      if (held) continue;
      insert(audience, "core_tag", {
        ...tag,
        tag_id: freeId(audience, "core_tag", "tag_id", String(tag.tag_id)),
        target_id: document.itemId,
        concept_id: folder.itemId,
        tagged_by_party_id: ownerPartyId(audience),
      });
    }
  }
}

function projectRows(
  audience: DatabaseSync,
  closure: WireClosure,
  keys: { origin: Buffer; audience: Buffer } | undefined
): Projected {
  const into: Projected = new Map();
  projectContentItems(audience, closure.rows.contentItems, into);
  projectDerivatives(audience, closure.rows.derivatives, into);
  projectMediaAssets(audience, closure.rows.mediaAssets, into);
  projectDocuments(audience, closure.rows.documents, into);
  projectDocsFolders(audience, closure.rows.docsFolders, into);
  for (const row of closure.rows.lockerItems) {
    if (!keys)
      throw new VaultShareError(
        "sharing a Locker item requires both vault encryption keys"
      );
    record(
      into,
      "locker.item",
      String(row.item_id),
      projectLockerItem(audience, row, keys)
    );
  }
  for (const group of closure.rows.tallyGroups) {
    record(
      into,
      "tally.group",
      String(group.group.group_id),
      projectTallyGroup(
        audience,
        group,
        (originContentId) =>
          into.get(keyOf("core.content_item", originContentId))?.contentId
      )
    );
  }
  projectCollections(audience, closure.rows.collections, into);
  return into;
}

function resolve(into: Projected, item: WireItem): ProjectedItem {
  const projection = into.get(keyOf(item.itemType, item.itemId));
  if (!projection)
    throw new VaultShareError(
      `incomplete share closure: ${item.itemType} ${item.itemId} carried no rows`
    );
  return projection;
}

/**
 * A LINEAGE CLAIM FOR EVERY PROJECTED ROW, KEYED BY THE SHAPE (#929).
 *
 * Every row the projection wrote is claimed, not only the top-level items —
 * the album, the folder. Stamping the items alone was the revoke evasion
 * (#916, adversarial BUG-9): an audience trashed a projected photograph, which
 * removed its collection entry, so removal's walk over LIVE membership found
 * nothing to sweep, and the asset and its content survived to be restored.
 *
 * SHAPE-KEYED, so two grants over one photograph are two claims and the second
 * one keeps the row when the first is revoked. That is the whole reason a
 * row-keyed provenance table, which names one sender, could not stay.
 *
 * A PLACEMENT CLAIMS NOTHING. Same-owner placement is a MOVE between the
 * owner's own vaults: the item ends up as the owner's own row, with no shape
 * to end and no sender to name, so a lineage row would assert a subscription
 * that does not exist (#928 A6).
 */
function recordLineage(
  audience: DatabaseSync,
  shape: ShareShapeClaim,
  projected: Projected,
  items: readonly ProjectedItem[]
): number {
  const write = audience.prepare(
    `INSERT INTO share_subscription_lineage
       (shape_id, target_type, target_id, origin_item_id, origin_row_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (shape_id, target_type, target_id) DO UPDATE SET
       origin_item_id = excluded.origin_item_id,
       origin_row_version = excluded.origin_row_version`
  );
  const claimed = new Set<string>();
  const claim = (
    itemType: ShareableItemType,
    itemId: string,
    originItemId: string
  ): void => {
    const entity = shareOriginEntityType(itemType);
    write.run(
      shape.shapeId,
      entity,
      itemId,
      originItemId,
      shape.rowVersions.get(`${entity} ${originItemId}`) ?? 0
    );
    claimed.add(`${entity} ${itemId}`);
  };
  for (const row of projected.values())
    claim(row.itemType, row.itemId, row.originItemId);
  // The named items last, so a top-level id wins the upsert if the two walks
  // ever disagree about which origin id a row came from.
  for (const item of items)
    claim(item.itemType, item.itemId, item.originItemId);
  return claimed.size;
}

/**
 * The subscription a projection is being ingested FOR. Absent on the placement
 * path, which claims nothing — see `recordLineage`.
 */
export interface ShareShapeClaim {
  shapeId: string;
  /** `<entity> <originItemId>` → the origin's replica change sequence. */
  rowVersions: ReadonlyMap<string, number>;
}

export interface ProjectShareClosureOptions {
  shape?: ShareShapeClaim;
  now?: () => number;
  keys?: { origin: Buffer; audience: Buffer };
}

export function projectShareClosure(
  audience: DatabaseSync,
  closure: WireClosure,
  options: ProjectShareClosureOptions
): ProjectResult {
  // Fail closed on unknown format. There is no COMPAT rung (pre-1.0).
  if (closure.formatVersion !== CLOSURE_FORMAT_VERSION)
    throw new VaultShareError(
      `unsupported share closure format ${String(closure.formatVersion)}`
    );
  const sharedAt = (options.now ?? Date.now)();
  // Savepoint when a caller already owns the audience transaction.
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT project_share_closure" : "BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(audience);
    const projected = projectRows(audience, closure, options.keys);
    const items = closure.items.map((item) => resolve(projected, item));
    const lineageRows = options.shape
      ? recordLineage(audience, options.shape, projected, items)
      : 0;
    runProjectionIngest(audience, [...projected.values()], {
      now: new Date(sharedAt).toISOString(),
    });
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE project_share_closure" : "COMMIT");
    return { items, rows: [...projected.values()], lineageRows };
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO project_share_closure" : "ROLLBACK");
    if (nested) audience.exec("RELEASE project_share_closure");
    throw error;
  }
}
