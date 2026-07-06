// Blob custody schema (issue #296, v9): the staging band bytes wait in
// before a command claims them, and the derivative registry (thumbs,
// previews, extracted text) hanging off canonical content items.
//
// `blob_staging` is deliberately NOT a registered logical entity — it is
// transient plumbing like the FTS shadow tables: raw bytes arriving is not a
// vault write; the command that claims them is. Unclaimed rows sweep after a
// TTL. `held_by_batch` pins a row past the TTL while an import draft batch
// references its bytes (the review pause must not race the sweep).
//
// `core_content_derivative` IS registered (core.content_derivative): what
// variants exist is model. Binary variants (thumb/preview) live in the CAS
// under their own sha; the text variant lives INLINE in `text_content` so
// the parent's FTS row can index extracted document text in-transaction —
// the same no-I/O constraint that keeps text/* bodies inline (issue #296 §1)
// applies to the index feed.
//
// A match inside a PDF must surface the DOCUMENT, so extracted text feeds
// the parent content item's own FTS row rather than a shadow row. The v2
// triggers rebuilt the row from `vault_content_text` alone — any title
// rename would clobber derivative text — so v9 recreates them with the
// derivative-aware body expression, and mirrors it from the derivative side.

/** Body of a content item's FTS row: extracted text wins, inline text else. */
const CONTENT_BODY = (ref: string) => `COALESCE(
    (SELECT d.text_content FROM core_content_derivative d
      WHERE d.content_id = ${ref}."content_id" AND d.variant = 'text'),
    vault_content_text(${ref}."media_type", ${ref}."content_uri"))`;

const REFRESH_PARENT_FTS = (idRef: string) => `
  DELETE FROM fts_core_content_item
   WHERE rowid = (SELECT rowid FROM core_content_item WHERE content_id = ${idRef});
  INSERT INTO fts_core_content_item (rowid, content_id, title, body)
  SELECT i.rowid, i."content_id", i."title", ${CONTENT_BODY('i')}
    FROM core_content_item i
   WHERE i.content_id = ${idRef} AND i."deleted_at" IS NULL;`;

export const BLOB_DDL = `
CREATE TABLE IF NOT EXISTS blob_staging (
  sha256        TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  original_name TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  staged_by     TEXT,
  held_by_batch TEXT,
  -- A staged DERIVATIVE rides beside its parent: claimed with it, swept with
  -- it. Generation is producer-agnostic (a client canvas today, a server
  -- codec plug-in later) — the registry doesn't care who downscaled.
  variant       TEXT CHECK (variant IN ('thumb','preview')),
  variant_of    TEXT CHECK ((variant IS NULL) = (variant_of IS NULL)),
  staged_at     TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS core_content_derivative (
  derivative_id TEXT PRIMARY KEY,
  content_id    TEXT NOT NULL REFERENCES core_content_item(content_id),
  variant       TEXT NOT NULL CHECK (variant IN ('thumb','preview','text')),
  sha256        TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  text_content  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (content_id, variant),
  CHECK ((variant = 'text') = (text_content IS NOT NULL)),
  CHECK ((variant = 'text') = (sha256 IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_derivative_content ON core_content_derivative(content_id);

-- Rebuild the content item's FTS sync derivative-aware (see header).
DROP TRIGGER IF EXISTS fts_core_content_item_ai;
DROP TRIGGER IF EXISTS fts_core_content_item_au;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_ai AFTER INSERT ON core_content_item BEGIN
  INSERT INTO fts_core_content_item (rowid, content_id, title, body)
  SELECT new.rowid, new."content_id", new."title", ${CONTENT_BODY('new')}
   WHERE new."deleted_at" IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_au AFTER UPDATE ON core_content_item BEGIN
  DELETE FROM fts_core_content_item WHERE rowid = old.rowid;
  INSERT INTO fts_core_content_item (rowid, content_id, title, body)
  SELECT new.rowid, new."content_id", new."title", ${CONTENT_BODY('new')}
   WHERE new."deleted_at" IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_content_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant = 'text'
BEGIN${REFRESH_PARENT_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant = 'text'
BEGIN${REFRESH_PARENT_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant = 'text'
BEGIN${REFRESH_PARENT_FTS('OLD.content_id')}
END;
`;
