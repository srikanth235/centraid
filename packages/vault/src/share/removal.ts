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
  if (itemType === "locker.item") {
    const removed = audience
      .prepare("DELETE FROM locker_item WHERE item_id = ?")
      .run(itemId).changes;
    return removed > 0 ? { ...ABSENT, removed: true } : ABSENT;
  }
  if (itemType === "tally.group") {
    return deleteTallyGroup(audience, itemId);
  }
  if (itemType === "core.collection") {
    return deleteCollection(audience, itemId);
  }
  let contentId: string;
  if (itemType === "core.content_item") {
    contentId = itemId;
  } else if (itemType === "core.document") {
    const document = audience
      .prepare(
        "SELECT current_content_id FROM core_document WHERE document_id = ?"
      )
      .get(itemId) as { current_content_id: string } | undefined;
    if (!document) return ABSENT;
    contentId = document.current_content_id;
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
  } else if (itemType === "core.document") {
    audience
      .prepare("DELETE FROM core_document WHERE document_id = ?")
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

function deleteCollection(
  audience: DatabaseSync,
  itemId: string
): RemovalResult {
  const held = audience
    .prepare("SELECT 1 FROM core_collection WHERE collection_id = ?")
    .get(itemId);
  if (!held) return ABSENT;
  const entries = audience
    .prepare(
      "SELECT target_type, target_id FROM core_collection_entry WHERE collection_id = ?"
    )
    .all(itemId) as Array<{ target_type: string; target_id: string }>;
  audience
    .prepare("DELETE FROM core_collection_entry WHERE collection_id = ?")
    .run(itemId);
  audience
    .prepare("DELETE FROM core_collection WHERE collection_id = ?")
    .run(itemId);
  const shas = new Set<string>();
  let removedContent = false;
  for (const entry of entries) {
    if (
      entry.target_type !== "media.media_asset" &&
      entry.target_type !== "core.document" &&
      entry.target_type !== "core.content_item"
    )
      continue;
    const result = deleteProjectedClosure(
      audience,
      entry.target_type,
      entry.target_id
    );
    removedContent ||= result.contentItemRemoved;
    for (const sha of result.shas) shas.add(sha);
  }
  return {
    removed: true,
    contentItemRemoved: removedContent,
    shas: [...shas],
  };
}

function deleteTallyGroup(
  audience: DatabaseSync,
  itemId: string
): RemovalResult {
  const group = audience
    .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
    .get(itemId) as { circle_id: string } | undefined;
  if (!group) return ABSENT;
  const templates = audience
    .prepare(
      "SELECT template_id FROM tally_recurring_expense WHERE group_id = ?"
    )
    .all(itemId) as Array<{ template_id: string }>;
  for (const template of templates) {
    audience
      .prepare(
        `DELETE FROM schedule_recurrence_exception
          WHERE target_type = 'tally.recurring_expense' AND target_id = ?`
      )
      .run(template.template_id);
  }
  audience
    .prepare("DELETE FROM tally_recurring_expense WHERE group_id = ?")
    .run(itemId);
  audience
    .prepare("DELETE FROM tally_settlement WHERE group_id = ?")
    .run(itemId);
  audience.prepare("DELETE FROM tally_expense WHERE group_id = ?").run(itemId);
  audience.prepare("DELETE FROM tally_group WHERE group_id = ?").run(itemId);
  audience
    .prepare("DELETE FROM social_circle_member WHERE circle_id = ?")
    .run(group.circle_id);
  audience
    .prepare("DELETE FROM social_circle WHERE circle_id = ?")
    .run(group.circle_id);
  return { removed: true, contentItemRemoved: false, shas: [] };
}
