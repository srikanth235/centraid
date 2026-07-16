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
CREATE INDEX IF NOT EXISTS idx_circle_member_party ON social_circle_member(party_id);

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
CREATE INDEX IF NOT EXISTS idx_thread_participant_party ON social_thread_participant(party_id);

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
CREATE INDEX IF NOT EXISTS idx_message_thread ON social_message(thread_id);
CREATE INDEX IF NOT EXISTS idx_message_sender_party ON social_message(sender_party_id);
CREATE INDEX IF NOT EXISTS idx_message_body_content ON social_message(body_content_id);
CREATE INDEX IF NOT EXISTS idx_message_in_reply_to ON social_message(in_reply_to_id);
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
  updated_at      TEXT NOT NULL,
  -- Trash (issue #308 A6): delete is reversible — the soft-delete pair, with
  -- real deletion deferred to the lifecycle sweep's purge window. The FTS
  -- spec's deletedColumn guard keeps trashed notes out of the index.
  deleted_at      TEXT,
  purge_at        TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_note_author_party ON knowledge_note(author_party_id);
CREATE INDEX IF NOT EXISTS idx_note_body_content ON knowledge_note(body_content_id);

CREATE TABLE knowledge_annotation (
  annotation_id   TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  selector_json   TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
  body_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_annotation_author_party ON knowledge_annotation(author_party_id);
`;

export const MEDIA_DDL = `
CREATE TABLE media_media_asset (
  asset_id         TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  kind             TEXT NOT NULL CHECK (kind IN ('photo','video','audio','scan')),
  captured_at      TEXT,
  -- Capture-local UTC offset in minutes (issue #419): captured_at is a UTC
  -- instant, so a native client needs the offset to render the wall-clock time
  -- the shutter fired at. NULL when the camera never recorded a zone. taken_at
  -- stays derived (captured_at, else content.created_at) — no duplicate column.
  tz_offset_min    INTEGER,
  place_id         TEXT REFERENCES core_place(place_id),
  camera_device_id TEXT REFERENCES consent_device(device_id),
  width            INTEGER CHECK (width > 0),
  height           INTEGER CHECK (height > 0),
  duration_s       REAL CHECK (duration_s >= 0),
  exif_json        TEXT CHECK (exif_json IS NULL OR json_valid(exif_json)),
  -- First-class asset state (issue #419) so the Photos replica shape is
  -- self-contained: favorite is a boolean on the asset (no more reconstructing
  -- it from a 3-table core_tag/core_concept join), and archive hides an asset
  -- from the timeline without trashing it. Trash is the deleted_at pair below.
  favorite         INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  archived_at      TEXT,
  -- The standard soft-delete pair (issue #274): every owner-deletable row
  -- carries its own grace window, not just the drive's content items.
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_asset_place ON media_media_asset(place_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_camera_device ON media_media_asset(camera_device_id);

CREATE TABLE media_face_region (
  region_id             TEXT PRIMARY KEY,
  asset_id              TEXT NOT NULL REFERENCES media_media_asset(asset_id),
  bbox_json             TEXT NOT NULL CHECK (json_valid(bbox_json)),
  party_id              TEXT REFERENCES core_party(party_id),
  confidence            REAL CHECK (confidence BETWEEN 0 AND 1),
  confirmed_by_party_id TEXT REFERENCES core_party(party_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_face_region_asset ON media_face_region(asset_id);
CREATE INDEX IF NOT EXISTS idx_face_region_party ON media_face_region(party_id);
CREATE INDEX IF NOT EXISTS idx_face_region_confirmed_by_party ON media_face_region(confirmed_by_party_id);
`;
