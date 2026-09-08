/*
 * THE LIBRARY'S READS, AS STATEMENTS (#996 wave 4b, R8).
 *
 * Nine of Notes' ten reads declared the truncation flag. The one that did
 * not — the note bodies — is the file's own comment on why the rest were wrong:
 * "an unbounded read is capped at 1000 rows server-side, so at photo-scale
 * vaults most note bodies fall outside the window and render blank." The same
 * was true of the notes, the links, the anchors, the tags and the notebooks;
 * only the bodies had been noticed.
 *
 * `from` names the PHYSICAL table because the same statement runs against the
 * seat's `vault.db` and against the gateway's paged door (W4-D2).
 */

import type { PageQuery } from "@centraid/core/page";

export const NOTES_NOTES: PageQuery = {
  name: "phone.notes.notes",
  select:
    "note_id, author_party_id, title, body_content_id, current_revision_id, " +
    "format, pinned, created_at, updated_at, deleted_at, purge_at",
  from: "knowledge_note",
  order: { sortColumn: "updated_at", pkColumn: "note_id", descending: true },
};

/*
 * THE LINK TABLES ARE THIS APP'S, NOT THE VAULT'S. `core_link` carries every
 * relation in the vault — a photo's place, a task's reference, a person's
 * activity — and Notes reads it to draw the edges BETWEEN NOTES. Read whole it
 * is the vault's entire edge set; bounded to notes on both ends it is the
 * graph the screen actually draws.
 */
export const NOTES_LINKS: PageQuery = {
  name: "phone.notes.links",
  select:
    "link_id, from_type, from_id, to_type, to_id, relation_concept_id, " +
    "valid_from, valid_to",
  from: "core_link",
  where: "from_type = ? OR to_type = ?",
  bind: ["knowledge.note", "knowledge.note"],
  order: { sortColumn: "from_id", pkColumn: "link_id", descending: false },
};

export const NOTES_ANCHORS: PageQuery = {
  name: "phone.notes.anchors",
  select: "anchor_id, link_id, selector_json, created_at",
  from: "core_link_anchor",
  where: `link_id IN (SELECT link_id FROM core_link
     WHERE from_type = 'knowledge.note' OR to_type = 'knowledge.note')`,
  order: { sortColumn: "link_id", pkColumn: "anchor_id", descending: false },
};

export const NOTES_SCHEMES: PageQuery = {
  name: "phone.notes.schemes",
  select: "scheme_id, uri, title",
  from: "core_concept_scheme",
  order: { sortColumn: "uri", pkColumn: "scheme_id", descending: false },
};

export const NOTES_CONCEPTS: PageQuery = {
  name: "phone.notes.concepts",
  select: "concept_id, scheme_id, notation, pref_label, broader_concept_id",
  from: "core_concept",
  order: { sortColumn: "scheme_id", pkColumn: "concept_id", descending: false },
};

/** Only the tags on notes; the shelves count notes, and nothing else. */
export const NOTES_TAGS: PageQuery = {
  name: "phone.notes.tags",
  select: "tag_id, target_type, target_id, concept_id, tagged_at",
  from: "core_tag",
  where: "target_type = ?",
  bind: ["knowledge.note"],
  order: { sortColumn: "target_id", pkColumn: "tag_id", descending: false },
};

/** Notebooks are collections (#274); the spine must name every one of them. */
export const NOTES_COLLECTIONS: PageQuery = {
  name: "phone.notes.collections",
  select:
    "collection_id, owner_party_id, name, cover_content_id, " +
    "parent_collection_id, sort_order",
  from: "core_collection",
  order: {
    sortColumn: "sort_order",
    pkColumn: "collection_id",
    descending: false,
  },
};

export const NOTES_PLACEMENTS: PageQuery = {
  name: "phone.notes.placements",
  select: "entry_id, collection_id, target_type, target_id, position, added_at",
  from: "core_collection_entry",
  where: "target_type = ?",
  bind: ["knowledge.note"],
  order: {
    sortColumn: "collection_id",
    pkColumn: "entry_id",
    descending: false,
  },
};

/** A note's history is its own occurrences (#996, R20(a)). */
export const NOTES_REVISIONS: PageQuery = {
  name: "phone.notes.revisions",
  select:
    "revision_id, entity_type, entity_id, operation, content_id, " +
    "parent_revision_id, recorded_at",
  from: "core_entity_revision",
  where: "entity_type = ?",
  bind: ["knowledge.note"],
  order: {
    sortColumn: "entity_id",
    pkColumn: "revision_id",
    descending: false,
  },
};
