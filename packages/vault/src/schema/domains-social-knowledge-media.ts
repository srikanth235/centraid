// Domain DDL — schemas `social`, `knowledge`, `media` from
// duaility-ontology.html §03.

export const SOCIAL_DDL = `
CREATE TABLE social_contact_card (
  card_id              TEXT PRIMARY KEY,
  party_id             TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  nickname             TEXT,
  -- Display label only (vCard ORG + TITLE). The employment CLAIM is a
  -- core.link (party -works-for-> org) with provenance, never a card field
  -- (issue #274 kink 4; the social boundary always said so).
  org_title            TEXT,
  vcard_rev            TEXT
) STRICT;

CREATE TABLE social_circle (
  circle_id      TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('family','friends','work','custom')),
  UNIQUE (owner_party_id, name)
) STRICT;

CREATE TABLE social_circle_member (
  member_id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES social_circle(circle_id),
  party_id  TEXT NOT NULL REFERENCES core_party(party_id),
  added_at  TEXT NOT NULL,
  UNIQUE (circle_id, party_id)
) STRICT;

CREATE TABLE social_thread (
  thread_id       TEXT PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('sms','email','dm','group')),
  subject         TEXT,
  external_ref    TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  last_message_at TEXT
) STRICT;

CREATE TABLE social_thread_participant (
  tp_id     TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES social_thread(thread_id),
  party_id  TEXT REFERENCES core_party(party_id),
  handle    TEXT,
  joined_at TEXT,
  muted     INTEGER NOT NULL CHECK (muted IN (0,1)),
  last_read_at TEXT,
  UNIQUE (thread_id, party_id),
  CHECK (party_id IS NOT NULL OR handle IS NOT NULL)
) STRICT;

CREATE TABLE social_message (
  message_id      TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES social_thread(thread_id),
  sender_party_id TEXT REFERENCES core_party(party_id),
  sender_handle   TEXT,
  sent_at         TEXT NOT NULL,
  body_content_id TEXT NOT NULL REFERENCES core_content_item(content_id),
  in_reply_to_id  TEXT REFERENCES social_message(message_id),
  delivery        TEXT NOT NULL CHECK (delivery IN ('draft','sent','delivered','read','failed')),
  external_id     TEXT UNIQUE,
  CHECK (sender_party_id IS NOT NULL OR sender_handle IS NOT NULL)
) STRICT;
`;

// v15 (issue #308 A6): the standard soft-delete pair on notes. Tier 1's
// rationale is "journaled and REVERSIBLE" — delete_note used to hard-delete
// the row, leaving the owner a receipt and no undo. Trash semantics give
// deletion the same grace window documents and media assets already have;
// the lifecycle sweep purges lapsed notes (edges included) for real.
//
// A rebuild rather than ALTER ADD COLUMN so the rung stays re-runnable
// (the ladder's standing property — the v3 backfill test replays it), in
// the v8 copy pattern. The DROP takes the v2 FTS sync triggers with the
// table, so they re-arm here WITH the live guard (the v9 precedent) —
// trashed notes leave the search index like trashed documents do — and the
// shadow rows rebuild to match.
export const KNOWLEDGE_TRASH_DDL = `
CREATE TABLE knowledge_note_v15 (
  note_id         TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title           TEXT NOT NULL,
  body_content_id TEXT NOT NULL REFERENCES core_content_item(content_id),
  format          TEXT NOT NULL CHECK (format IN ('markdown','html','plain')),
  pinned          INTEGER NOT NULL CHECK (pinned IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  purge_at        TEXT
) STRICT;
INSERT INTO knowledge_note_v15
  (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
SELECT note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at
  FROM knowledge_note;
DROP TABLE knowledge_note;
ALTER TABLE knowledge_note_v15 RENAME TO knowledge_note;

DROP TRIGGER IF EXISTS fts_knowledge_note_ai;
DROP TRIGGER IF EXISTS fts_knowledge_note_au;
DROP TRIGGER IF EXISTS fts_knowledge_note_ad;
CREATE TRIGGER fts_knowledge_note_ai AFTER INSERT ON knowledge_note BEGIN
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT new.rowid, new."note_id", new."title",
         (SELECT vault_content_text(media_type, content_uri) FROM core_content_item
           WHERE content_id = new."body_content_id")
   WHERE new."deleted_at" IS NULL;
END;
CREATE TRIGGER fts_knowledge_note_au AFTER UPDATE ON knowledge_note BEGIN
  DELETE FROM fts_knowledge_note WHERE rowid = old.rowid;
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT new.rowid, new."note_id", new."title",
         (SELECT vault_content_text(media_type, content_uri) FROM core_content_item
           WHERE content_id = new."body_content_id")
   WHERE new."deleted_at" IS NULL;
END;
CREATE TRIGGER fts_knowledge_note_ad AFTER DELETE ON knowledge_note BEGIN
  DELETE FROM fts_knowledge_note WHERE rowid = old.rowid;
END;
DELETE FROM fts_knowledge_note;
INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
SELECT b.rowid, b."note_id", b."title",
       (SELECT vault_content_text(media_type, content_uri) FROM core_content_item
         WHERE content_id = b."body_content_id")
  FROM knowledge_note b
 WHERE b."deleted_at" IS NULL;
`;

export const KNOWLEDGE_DDL = `
CREATE TABLE knowledge_note (
  note_id         TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title           TEXT NOT NULL,
  body_content_id TEXT NOT NULL REFERENCES core_content_item(content_id),
  format          TEXT NOT NULL CHECK (format IN ('markdown','html','plain')),
  pinned          INTEGER NOT NULL CHECK (pinned IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE TABLE knowledge_annotation (
  annotation_id   TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  selector_json   TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
  body_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
`;

export const MEDIA_DDL = `
CREATE TABLE media_media_asset (
  asset_id         TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  kind             TEXT NOT NULL CHECK (kind IN ('photo','video','audio','scan')),
  captured_at      TEXT,
  place_id         TEXT REFERENCES core_place(place_id),
  camera_device_id TEXT REFERENCES consent_device(device_id),
  width            INTEGER CHECK (width > 0),
  height           INTEGER CHECK (height > 0),
  duration_s       REAL CHECK (duration_s >= 0),
  exif_json        TEXT CHECK (exif_json IS NULL OR json_valid(exif_json)),
  -- The standard soft-delete pair (issue #274): every owner-deletable row
  -- carries its own grace window, not just the drive's content items.
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;

CREATE TABLE media_face_region (
  region_id             TEXT PRIMARY KEY,
  asset_id              TEXT NOT NULL REFERENCES media_media_asset(asset_id),
  bbox_json             TEXT NOT NULL CHECK (json_valid(bbox_json)),
  party_id              TEXT REFERENCES core_party(party_id),
  confidence            REAL CHECK (confidence BETWEEN 0 AND 1),
  confirmed_by_party_id TEXT REFERENCES core_party(party_id)
) STRICT;
`;
