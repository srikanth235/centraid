import type { DatabaseSync } from "node:sqlite";

import { mediaLocationPolicyForVault } from "../blob/staging.js";
import { isBlobUri } from "../blob/store.js";
import { VaultShareError } from "../errors.js";
import type {
  BlobManifestEntry,
  ContentItemRow,
  DerivativeRow,
  DocumentRow,
  MediaAssetRow,
  ShareableItemType,
  WireClosure,
  WireCollection,
  WireDocsFolder,
  WireItem,
  WireRow,
  WireRows,
  WireTallyGroup,
} from "./closure.js";
import { CLOSURE_FORMAT_VERSION } from "./closure.js";
import { readTallyGroup } from "./read-tally.js";
import { one } from "./sql.js";

const CONTENT_ITEM_COLUMNS = `content_id, media_type, content_uri, sha256, byte_size, title,
       language, deleted_at, purge_at, created_at`;

const DERIVATIVE_COLUMNS = `derivative_id, content_id, variant, sha256, media_type,
       byte_size, text_content, created_at`;

const MEDIA_ASSET_COLUMNS = `asset_id, content_id, kind, captured_at, tz_offset_min,
       capture_group_id, width, height, duration_s, exif_json,
       archived_at, deleted_at, purge_at`;

const COLLECTION_ENTRY_TYPES = new Set<ShareableItemType>([
  "media.asset",
  "core.document",
  "core.content_item",
]);

interface ClosureDraft {
  contentItems: Map<string, ContentItemRow>;
  derivatives: Map<string, DerivativeRow>;
  mediaAssets: Map<string, MediaAssetRow>;
  documents: Map<string, DocumentRow>;
  docsFolders: Map<string, WireDocsFolder>;
  collections: Map<string, WireCollection>;
  lockerItems: Map<string, WireRow>;
  tallyGroups: Map<string, WireTallyGroup>;
  blobs: Map<string, BlobManifestEntry>;
}

function draft(): ClosureDraft {
  return {
    contentItems: new Map(),
    derivatives: new Map(),
    mediaAssets: new Map(),
    documents: new Map(),
    docsFolders: new Map(),
    collections: new Map(),
    lockerItems: new Map(),
    tallyGroups: new Map(),
    blobs: new Map(),
  };
}

function poolContent(
  origin: DatabaseSync,
  into: ClosureDraft,
  contentId: string
): boolean {
  if (into.contentItems.has(contentId)) return true;
  const item = origin
    .prepare(
      `SELECT ${CONTENT_ITEM_COLUMNS} FROM core_content_item WHERE content_id = ?`
    )
    .get(contentId) as ContentItemRow | undefined;
  if (!item) return false;
  into.contentItems.set(contentId, item);
  if (isBlobUri(item.content_uri) && !into.blobs.has(item.sha256)) {
    into.blobs.set(item.sha256, {
      sha256: item.sha256,
      rung: "original",
      size: item.byte_size,
    });
  }
  const derivatives = origin
    .prepare(
      `SELECT ${DERIVATIVE_COLUMNS} FROM core_content_derivative
        WHERE content_id = ? ORDER BY variant`
    )
    .all(contentId) as unknown as DerivativeRow[];
  for (const derivative of derivatives) {
    into.derivatives.set(derivative.derivative_id, derivative);
    if (derivative.sha256 === null || into.blobs.has(derivative.sha256))
      continue;
    into.blobs.set(derivative.sha256, {
      sha256: derivative.sha256,
      rung: derivative.variant,
      size: derivative.byte_size,
    });
  }
  return true;
}

function requireContent(
  origin: DatabaseSync,
  into: ClosureDraft,
  contentId: string
): void {
  if (!poolContent(origin, into, contentId))
    throw new VaultShareError(
      `core.content_item ${contentId} is not in the origin vault`
    );
}

function absent(itemType: ShareableItemType, itemId: string): VaultShareError {
  return new VaultShareError(
    `${itemType} ${itemId} is not in the origin vault`
  );
}

function stripGpsFromExif(exifJson: string | null): string | null {
  if (exifJson === null) return null;
  let exif: Record<string, unknown>;
  try {
    exif = JSON.parse(exifJson) as Record<string, unknown>;
  } catch {
    return exifJson;
  }
  if (!("latitude" in exif) && !("longitude" in exif)) return exifJson;
  const { latitude: _latitude, longitude: _longitude, ...rest } = exif;
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null;
}

function poolMediaAsset(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string,
  redactLocation: boolean
): void {
  if (into.mediaAssets.has(itemId)) return;
  const asset = origin
    .prepare(
      `SELECT ${MEDIA_ASSET_COLUMNS} FROM media_asset WHERE asset_id = ?`
    )
    .get(itemId) as MediaAssetRow | undefined;
  if (!asset) throw absent("media.asset", itemId);
  into.mediaAssets.set(
    itemId,
    redactLocation && mediaLocationPolicyForVault(origin) === "strip"
      ? { ...asset, exif_json: stripGpsFromExif(asset.exif_json) }
      : asset
  );
  requireContent(origin, into, asset.content_id);
}

function poolDocument(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string
): void {
  if (into.documents.has(itemId)) return;
  const document = origin
    .prepare(
      `SELECT document_id, title, current_content_id, created_at, updated_at,
              deleted_at, purge_at
         FROM core_document WHERE document_id = ?`
    )
    .get(itemId) as DocumentRow | undefined;
  if (!document) throw absent("core.document", itemId);
  into.documents.set(itemId, document);
  requireContent(origin, into, document.current_content_id);
}

function poolCollection(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string,
  redactLocation: boolean
): void {
  if (into.collections.has(itemId)) return;
  const row = one(origin, "core_collection", "collection_id", itemId);
  if (!row) throw absent("core.collection", itemId);
  const entries = origin
    .prepare(
      "SELECT * FROM core_collection_entry WHERE collection_id = ? ORDER BY position"
    )
    .all(itemId) as WireRow[];
  into.collections.set(itemId, { row, entries });
  for (const entry of entries) {
    const targetType = String(entry.target_type);
    if (!COLLECTION_ENTRY_TYPES.has(targetType as ShareableItemType)) {
      throw new VaultShareError(
        `collection entry type ${targetType} cannot cross a vault boundary`
      );
    }
    poolItem(
      origin,
      into,
      targetType as ShareableItemType,
      String(entry.target_id),
      redactLocation
    );
  }
}

const DOCS_FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";

function poolDocsFolder(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string
): void {
  if (into.docsFolders.has(itemId)) return;
  const scheme = origin
    .prepare(
      `SELECT s.* FROM core_concept_scheme s
        JOIN core_concept c ON c.scheme_id = s.scheme_id
       WHERE c.concept_id = ? AND c.notation != 'root' AND s.uri = ?`
    )
    .get(itemId, DOCS_FOLDER_SCHEME_URI) as WireRow | undefined;
  if (!scheme) throw absent("docs.folder", itemId);
  const folders = origin
    .prepare(
      `WITH RECURSIVE descendants(concept_id, scheme_id, notation, pref_label,
                                  alt_labels_json, broader_concept_id, definition, depth) AS (
         SELECT concept_id, scheme_id, notation, pref_label, alt_labels_json,
                broader_concept_id, definition, 0
           FROM core_concept WHERE concept_id = ?
         UNION ALL
         SELECT child.concept_id, child.scheme_id, child.notation, child.pref_label,
                child.alt_labels_json, child.broader_concept_id, child.definition,
                parent.depth + 1
           FROM core_concept child
           JOIN descendants parent ON child.broader_concept_id = parent.concept_id
       )
       SELECT concept_id, scheme_id, notation, pref_label, alt_labels_json,
              broader_concept_id, definition
         FROM descendants ORDER BY depth, concept_id`
    )
    .all(itemId) as WireRow[];
  const folderIds = folders.map((folder) => String(folder.concept_id));
  const slots = folderIds.map(() => "?").join(", ");
  const tags = origin
    .prepare(
      `SELECT * FROM core_tag
        WHERE target_type = 'core.document' AND concept_id IN (${slots})
        ORDER BY tag_id`
    )
    .all(...folderIds) as WireRow[];
  for (const tag of tags) {
    poolDocument(origin, into, String(tag.target_id));
  }
  into.docsFolders.set(itemId, { scheme, folders, tags });
}

function poolLockerItem(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string
): void {
  if (into.lockerItems.has(itemId)) return;
  const row = one(origin, "locker_item", "item_id", itemId);
  if (!row) throw absent("locker.item", itemId);
  into.lockerItems.set(itemId, row);
}

function poolTallyGroup(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemId: string
): void {
  if (into.tallyGroups.has(itemId)) return;
  into.tallyGroups.set(
    itemId,
    readTallyGroup(origin, itemId, (contentId) =>
      poolContent(origin, into, contentId)
    )
  );
}

function poolItem(
  origin: DatabaseSync,
  into: ClosureDraft,
  itemType: ShareableItemType,
  itemId: string,
  redactLocation: boolean
): void {
  switch (itemType) {
    case "core.content_item":
      requireContent(origin, into, itemId);
      return;
    case "media.asset":
      poolMediaAsset(origin, into, itemId, redactLocation);
      return;
    case "core.document":
      poolDocument(origin, into, itemId);
      return;
    case "core.collection":
      poolCollection(origin, into, itemId, redactLocation);
      return;
    case "docs.folder":
      poolDocsFolder(origin, into, itemId);
      return;
    case "locker.item":
      poolLockerItem(origin, into, itemId);
      return;
    case "tally.group":
      poolTallyGroup(origin, into, itemId);
  }
}

export interface ReadShareClosureInput {
  originVaultId: string;
  itemType: ShareableItemType;
  itemIds: readonly string[];
  crossOwner?: boolean;
}

export function readShareClosure(
  origin: DatabaseSync,
  input: ReadShareClosureInput
): WireClosure {
  const itemIds = [...new Set(input.itemIds)];
  if (itemIds.length === 0)
    throw new VaultShareError("a share closure needs at least one item");
  const into = draft();
  const redactLocation = input.crossOwner === true;
  const items: WireItem[] = itemIds.map((itemId) => {
    poolItem(origin, into, input.itemType, itemId, redactLocation);
    return { itemType: input.itemType, itemId };
  });
  const rowTables: WireRows = {
    contentItems: [...into.contentItems.values()],
    derivatives: [...into.derivatives.values()],
    mediaAssets: [...into.mediaAssets.values()],
    documents: [...into.documents.values()],
    docsFolders: [...into.docsFolders.values()],
    collections: [...into.collections.values()],
    lockerItems: [...into.lockerItems.values()],
    tallyGroups: [...into.tallyGroups.values()],
  };
  return {
    formatVersion: CLOSURE_FORMAT_VERSION,
    originVaultId: input.originVaultId,
    items,
    rows: rowTables,
    blobs: [...into.blobs.values()],
  };
}
