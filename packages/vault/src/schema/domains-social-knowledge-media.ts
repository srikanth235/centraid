import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SOCIAL_DDL = `
CREATE TABLE social_circle (
  circle_id      TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('family','friends','work','custom')),
  created_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (owner_party_id, name),
  FOREIGN KEY (circle_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE social_circle_member (
  member_id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES social_circle(circle_id),
  party_id  TEXT NOT NULL REFERENCES core_party(party_id),
  added_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (circle_id, party_id),
  FOREIGN KEY (member_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_circle_member_party ON social_circle_member(party_id);

CREATE TABLE social_thread (
  thread_id       TEXT PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('sms','email','dm','group')),
  subject         TEXT,
  external_ref    TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  -- Rebuildable projection (issue #441 A3), the blob_custody_state pattern:
  -- last_message_at is a cache of MAX(social_message.sent_at) over the thread's
  -- messages — the natural sort key for a thread list. Writers keep it fresh on
  -- the happy path (send, publish, import), but import corrections and message
  -- purges can drift it, so the standing sweep (gateway/duties.ts) HEALS it
  -- wholesale — one UPDATE recomputing it from the messages — exactly as
  -- blob_custody_state is rebuilt. It is therefore never a source of truth.
  last_message_at TEXT,
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (thread_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE social_thread_participant (
  tp_id     TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES social_thread(thread_id),
  party_id  TEXT REFERENCES core_party(party_id),
  handle    TEXT,
  joined_at TEXT,
  muted     INTEGER NOT NULL CHECK (muted IN (0,1)),
  last_read_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (thread_id, party_id),
  CHECK (party_id IS NOT NULL OR handle IS NOT NULL),
  FOREIGN KEY (tp_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
  created_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  CHECK (sender_party_id IS NOT NULL OR sender_handle IS NOT NULL),
  FOREIGN KEY (message_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_message_thread ON social_message(thread_id);
CREATE INDEX IF NOT EXISTS idx_message_sender_party ON social_message(sender_party_id);
CREATE INDEX IF NOT EXISTS idx_message_body_content ON social_message(body_content_id);
CREATE INDEX IF NOT EXISTS idx_message_in_reply_to ON social_message(in_reply_to_id);
-- #883: a thread view is every message in one thread, oldest first, and the
-- thread-only index made SQLite sort every message this vault holds.
CREATE INDEX IF NOT EXISTS idx_message_thread_sent ON social_message(thread_id, sent_at);
${touchUpdatedAt("social_circle", "circle_id")}
${touchUpdatedAt("social_circle_member", "member_id")}
${touchUpdatedAt("social_thread", "thread_id")}
${touchUpdatedAt("social_thread_participant", "tp_id")}
${touchUpdatedAt("social_message", "message_id")}
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
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash (issue #308 A6): delete is reversible — the soft-delete pair, with
  -- real deletion deferred to the lifecycle sweep's purge window. The FTS
  -- spec's deletedColumn guard keeps trashed notes out of the index. The guard
  -- (issue #441 A4) makes purge_at-without-deleted_at unrepresentable, matching
  -- core_content_item / core_document / media_asset.
  deleted_at      TEXT,
  purge_at        TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (note_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_note_purge_idx
  ON knowledge_note(purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_note_author_party ON knowledge_note(author_party_id);
CREATE INDEX IF NOT EXISTS idx_note_body_content ON knowledge_note(body_content_id);

CREATE TABLE knowledge_annotation (
  annotation_id   TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  selector_json   TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
  body_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (annotation_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_annotation_author_party ON knowledge_annotation(author_party_id);
CREATE INDEX IF NOT EXISTS idx_annotation_target
  ON knowledge_annotation(target_type, target_id);
${touchUpdatedAt("knowledge_note", "note_id")}
${touchUpdatedAt("knowledge_annotation", "annotation_id")}
`;

export const MEDIA_DDL = `
CREATE TABLE media_asset (
  asset_id         TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  kind             TEXT NOT NULL CHECK (kind IN ('photo','video','audio','scan')),
  captured_at      TEXT,
  -- Capture-local UTC offset in minutes (issue #419): captured_at is a UTC
  -- instant, so a native client needs the offset to render the wall-clock time
  -- the shutter fired at. NULL when the camera never recorded a zone. taken_at
  -- stays derived (captured_at, else content.created_at) — no duplicate column.
  tz_offset_min    INTEGER,
  -- Stable logical capture grouping for Live Photo / motion-photo companions.
  capture_group_id TEXT,
  place_id         TEXT REFERENCES core_place(place_id),
  camera_device_id TEXT REFERENCES access_device(device_id),
  width            INTEGER CHECK (width > 0),
  height           INTEGER CHECK (height > 0),
  duration_s       REAL CHECK (duration_s >= 0),
  exif_json        TEXT CHECK (exif_json IS NULL OR json_valid(exif_json)),
  -- Edit lineage (issue #711). The photo editor is non-destructive: saving an
  -- edit writes a NEW asset beside the original and never touches the source
  -- bytes, so the copy has to say what it came from or the provenance is lost
  -- the moment it lands. Self-referencing FK, NULL for every camera original
  -- and every import — "no source" is a real answer the UI must be able to
  -- read and say plainly, not a hole to paper over with the copy's own
  -- capture date. An asset may not be its own source (an edit of itself is
  -- not a thing the editor can produce). SQLite never auto-indexes a child FK
  -- column, and merge.ts re-points FKs by UPDATE, so it carries its own index.
  source_asset_id  TEXT REFERENCES media_asset(asset_id)
                     CHECK (source_asset_id IS NULL OR source_asset_id <> asset_id),
  -- No \`favorite\` column (#916, ruling ONT-03). The star was a MIRROR of the
  -- \`starred\` tag in the flags scheme that Docs, Locker and People already
  -- use, and a mirror has two truths. Archive hides an asset from the timeline
  -- without trashing it; trash is the deleted_at pair below.
  archived_at      TEXT,
  -- The standard soft-delete pair (issue #274): every owner-deletable row
  -- carries its own grace window, not just the drive's content items.
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Archived and trashed are different answers, and a row claiming both is
  -- neither (#916).
  CHECK (archived_at IS NULL OR deleted_at IS NULL),
  FOREIGN KEY (asset_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS media_asset_purge_idx
  ON media_asset(purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_asset_place ON media_asset(place_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_camera_device ON media_asset(camera_device_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_capture_group ON media_asset(capture_group_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_source ON media_asset(source_asset_id);

CREATE TABLE media_face_region (
  region_id             TEXT PRIMARY KEY,
  asset_id              TEXT NOT NULL REFERENCES media_asset(asset_id),
  bbox_json             TEXT NOT NULL CHECK (json_valid(bbox_json)),
  -- The person this face IS. It yields to their purge rather than blocking it
  -- (#916, D1): forgetting a person must take their name off their faces, and
  -- the CHECK below stays satisfied because a NULL party is always allowed.
  -- \`confirmed_by_party_id\` does NOT yield — the CHECK ties it to
  -- \`review_state\`, so a foreign-key SET NULL would leave a 'confirmed' row
  -- with no confirmer and fail the constraint mid-purge.
  party_id              TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  confidence            REAL CHECK (confidence BETWEEN 0 AND 1),
  confirmed_by_party_id TEXT REFERENCES core_party(party_id),
  -- WHERE A REVIEW QUEUE ENDS (issue #712). Before this column the table could
  -- only say "confirmed or not", so two of the three answers a member actually
  -- gives had nowhere to live: "reviewed, deliberately left unnamed" was not
  -- expressible at all, and "rejected" was a DELETE — which is not a state, so
  -- the enricher's next run was free to propose the same stranger again and
  -- the queue could never be finished. media.answer_face_proposal writes
  -- this; nothing else does.
  review_state          TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (review_state IN ('proposed','confirmed','rejected','dismissed')),
  created_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- ONE SOURCE OF TRUTH, STRUCTURALLY. "confirmed" is already derivable from
  -- confirmed_by_party_id, so the two facts are pinned to each other here
  -- rather than left to agree by convention: a writer cannot mark a region
  -- confirmed without naming who confirmed it, and cannot name a confirmer
  -- without the state saying so. Readers may use either and never disagree.
  CHECK ((review_state = 'confirmed') = (confirmed_by_party_id IS NOT NULL)),
  -- A PARTY IS AN ASSERTION, NOT A LEFTOVER. party_id on a proposed region is
  -- the enricher's candidate; on a confirmed one it is the owner's word.
  -- A rejected or dismissed region asserts neither, so it carries no party --
  -- which is what keeps rejected rows (now that they survive) out of every
  -- per-person count that falls back from confirmed_by_party_id to party_id.
  CHECK (review_state IN ('proposed','confirmed') OR party_id IS NULL),
  FOREIGN KEY (region_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_face_region_asset ON media_face_region(asset_id);
CREATE INDEX IF NOT EXISTS idx_face_region_party ON media_face_region(party_id);
CREATE INDEX IF NOT EXISTS idx_face_region_confirmed_by_party ON media_face_region(confirmed_by_party_id);
${touchUpdatedAt("media_asset", "asset_id")}
${touchUpdatedAt("media_face_region", "region_id")}
`;
