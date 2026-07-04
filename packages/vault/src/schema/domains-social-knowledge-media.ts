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
  note                 TEXT,
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

CREATE TABLE knowledge_notebook (
  notebook_id        TEXT PRIMARY KEY,
  owner_party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  name               TEXT NOT NULL,
  parent_notebook_id TEXT REFERENCES knowledge_notebook(notebook_id),
  sort_order         INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_note_placement (
  placement_id TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES knowledge_note(note_id),
  notebook_id  TEXT NOT NULL REFERENCES knowledge_notebook(notebook_id),
  position     INTEGER NOT NULL,
  UNIQUE (note_id, notebook_id)
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
  deleted_at       TEXT
) STRICT;

CREATE TABLE media_album (
  album_id       TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title          TEXT NOT NULL,
  cover_asset_id TEXT REFERENCES media_media_asset(asset_id),
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE media_album_entry (
  entry_id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES media_album(album_id),
  asset_id TEXT NOT NULL REFERENCES media_media_asset(asset_id),
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (album_id, asset_id)
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
