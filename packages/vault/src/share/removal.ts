// Removing a projection — the unshare half of share-by-placement (issue #599
// decision 11).
//
// Unshare deletes the projected rows in the AUDIENCE vault and nothing else.
// The origin row and its bytes are untouched: the origin holds its own
// directory entry onto the same inode, so unlinking the audience's entry can
// never free the owner's bytes. The audience's own blob goes orphaned and its
// existing GC unlinks it on schedule — this module never touches the CAS.
//
// The content item is deleted only when nothing ELSE in the audience vault
// still references it. That check walks the live schema (`PRAGMA
// foreign_key_list`) rather than a remembered list of referrers, so a table
// added later is covered without anyone having to update a sweep clause here.

import type { DatabaseSync } from "node:sqlite";

import { isBlobUri } from "../blob/store.js";
import type { ShareableItemType } from "./closure.js";

interface ForeignKeyRow {
  table: string;
  from: string;
  on_delete: string;
}

/**
 * Every `(table, column)` in this vault that FKs `core_content_item`, minus
 * the ones that clean themselves up (`ON DELETE CASCADE`). Derived from the
 * live schema so it cannot rot.
 */
function contentItemReferrers(
  db: DatabaseSync
): { table: string; column: string }[] {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const referrers: { table: string; column: string }[] = [];
  for (const table of tables) {
    const fks = db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all() as unknown as ForeignKeyRow[];
    for (const fk of fks) {
      if (fk.table !== "core_content_item") continue;
      if (fk.on_delete === "CASCADE") continue;
      referrers.push({ table, column: fk.from });
    }
  }
  return referrers;
}

function isReferenced(db: DatabaseSync, contentId: string): boolean {
  for (const ref of contentItemReferrers(db)) {
    const hit = db
      .prepare(
        `SELECT 1 AS present FROM "${ref.table}" WHERE "${ref.column}" = ? LIMIT 1`
      )
      .get(contentId);
    if (hit) return true;
  }
  return false;
}

/** What a removal actually did in the audience vault. */
export interface RemovalResult {
  /** False when the projected row was already gone. */
  removed: boolean;
  /** False when another audience row still claims the content item. */
  contentItemRemoved: boolean;
  /** Content addresses the removed rows had been claiming. */
  shas: string[];
}

const ABSENT: RemovalResult = {
  removed: false,
  contentItemRemoved: false,
  shas: [],
};

/**
 * Delete a projected closure from the audience vault. The caller owns the
 * transaction (unshare is one single-DB transaction, same as share).
 */
export function deleteProjectedClosure(
  audience: DatabaseSync,
  itemType: ShareableItemType,
  itemId: string
): RemovalResult {
  let contentId: string;
  if (itemType === "core.content_item") {
    contentId = itemId;
  } else {
    const asset = audience
      .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
      .get(itemId) as { content_id: string } | undefined;
    if (!asset) return ABSENT;
    contentId = asset.content_id;
  }
  const item = audience
    .prepare(
      "SELECT content_uri, sha256 FROM core_content_item WHERE content_id = ?"
    )
    .get(contentId) as { content_uri: string; sha256: string } | undefined;
  if (!item) return ABSENT;

  const shas = new Set<string>();
  if (isBlobUri(item.content_uri)) shas.add(item.sha256);
  const derivatives = audience
    .prepare("SELECT sha256 FROM core_content_derivative WHERE content_id = ?")
    .all(contentId) as { sha256: string | null }[];
  for (const derivative of derivatives) {
    if (derivative.sha256 !== null) shas.add(derivative.sha256);
  }

  if (itemType === "media.media_asset") {
    audience
      .prepare("DELETE FROM media_media_asset WHERE asset_id = ?")
      .run(itemId);
  }
  audience
    .prepare("DELETE FROM core_content_derivative WHERE content_id = ?")
    .run(contentId);
  const contentItemRemoved = !isReferenced(audience, contentId);
  if (contentItemRemoved) {
    audience
      .prepare("DELETE FROM core_content_item WHERE content_id = ?")
      .run(contentId);
  }
  return { removed: true, contentItemRemoved, shas: [...shas] };
}
