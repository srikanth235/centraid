// The pieces both Locker command packs need (#872): the item's logical name,
// the SKOS tag scheme, and the three "replace this decoration" helpers (tags,
// connector alias, service anchor). Nothing here is a command.

import type { HandlerCtx } from "../gateway/types.js";

export const LOCKER_ITEM_TYPE = "locker.item";

/** SKOS locker-tags scheme (#310), not a second tag table. https, not urn:. */
export const LOCKER_TAGS_SCHEME_URI =
  "https://centraid.dev/schemes/locker-tags";

export function lockerTagsSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare("SELECT scheme_id FROM core_concept_scheme WHERE uri = ?")
    .get(LOCKER_TAGS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Locker tags', 'centraid', '1')`
    )
    .run(schemeId, LOCKER_TAGS_SCHEME_URI);
  return schemeId;
}

export function setTags(
  ctx: HandlerCtx,
  itemId: string,
  tags: readonly string[]
): void {
  const schemeId = lockerTagsSchemeId(ctx);
  ctx.db
    .prepare(
      `DELETE FROM core_tag
        WHERE target_type = ? AND target_id = ?
          AND concept_id IN (SELECT concept_id FROM core_concept WHERE scheme_id = ?)`
    )
    .run(LOCKER_ITEM_TYPE, itemId, schemeId);
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    let conceptId = (
      ctx.db
        .prepare(
          "SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?"
        )
        .get(schemeId, tag) as { concept_id: string } | undefined
    )?.concept_id;
    if (!conceptId) {
      conceptId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL)`
        )
        .run(conceptId, schemeId, tag, tag);
    }
    const tagId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        tagId,
        LOCKER_ITEM_TYPE,
        itemId,
        conceptId,
        owner?.self_party_id ?? null,
        ctx.now
      );
    ctx.wrote("core.tag", tagId);
  }
}

/** Set or clear (`''`) the service anchor (#310). Validated live — no opaque pointer. */
export function setConnection(
  ctx: HandlerCtx,
  itemId: string,
  connectionId: string
): void {
  const trimmed = connectionId.trim();
  if (trimmed.length === 0) {
    ctx.db
      .prepare("UPDATE locker_item SET connection_id = NULL WHERE item_id = ?")
      .run(itemId);
    return;
  }
  const live = ctx.db
    .prepare("SELECT 1 AS x FROM sync_connection WHERE connection_id = ?")
    .get(trimmed);
  if (!live) throw new Error(`no sync.connection with id ${trimmed}`);
  ctx.db
    .prepare("UPDATE locker_item SET connection_id = ? WHERE item_id = ?")
    .run(trimmed, itemId);
}

/** Set or clear (`''`) the connector alias (#298). Unique among LIVE items;
 *  a trashed holder yields it. The mapping is a REGISTERED table, so an app
 *  reads back what this writes (README-Locker §8). */
export function setAlias(ctx: HandlerCtx, itemId: string, alias: string): void {
  const previous = ctx.db
    .prepare("SELECT alias FROM locker_item_alias WHERE item_id = ?")
    .get(itemId) as { alias: string } | undefined;
  ctx.db.prepare("DELETE FROM locker_item_alias WHERE item_id = ?").run(itemId);
  if (previous) ctx.wrote("locker.item_alias", previous.alias);
  const trimmed = alias.trim();
  if (trimmed.length === 0) return;
  const clash = ctx.db
    .prepare(
      `SELECT a.item_id FROM locker_item_alias a
         JOIN locker_item i ON i.item_id = a.item_id
        WHERE a.alias = ? AND i.deleted_at IS NULL AND a.item_id <> ?`
    )
    .get(trimmed, itemId) as { item_id: string } | undefined;
  if (clash)
    throw new Error(`alias "${trimmed}" is already used by another live item`);
  ctx.db
    .prepare(
      "INSERT OR REPLACE INTO locker_item_alias (alias, item_id) VALUES (?, ?)"
    )
    .run(trimmed, itemId);
  ctx.wrote("locker.item_alias", trimmed);
}
