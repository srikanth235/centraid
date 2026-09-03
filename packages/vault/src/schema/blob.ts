import type { DatabaseSync } from "node:sqlite";

import { truncateForIndex } from "./fts.js";
import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

const DOCUMENT_BODY = (ref: string) =>
  truncateForIndex(`COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."current_content_id" AND dv.variant = 'transcript'),
    (SELECT vault_content_text(ci."media_type", ci."content_uri") FROM core_content_item ci
      WHERE ci.content_id = ${ref}."current_content_id"))`);

const CONTENT_ITEM_SEARCH_TEXT = (ref: string) =>
  truncateForIndex(`trim(COALESCE(${ref}."title", '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."content_id" AND dv.variant = 'transcript'), ''))`);

const REFRESH_DOCUMENT_FTS = (contentIdRef: string) => `
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = ${contentIdRef});
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", ${DOCUMENT_BODY("d")}
    FROM core_document d
   WHERE d.current_content_id = ${contentIdRef} AND d."deleted_at" IS NULL;`;

const REFRESH_CONTENT_ITEM_FTS = (contentIdRef: string) => `
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = ${contentIdRef});
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, ${CONTENT_ITEM_SEARCH_TEXT("i")}
    FROM core_content_item i
   WHERE i.content_id = ${contentIdRef} AND i.deleted_at IS NULL;`;

export const BLOB_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS blob_replica (
  sha256        TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  replicated_at TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  store         TEXT NOT NULL DEFAULT 'cas' CHECK (store IN ('cas','derived'))
) STRICT;

CREATE TABLE IF NOT EXISTS blob_access (
  sha256         TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  last_access_at TEXT NOT NULL,
  byte_size      INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_blob_access_lru ON blob_access(last_access_at);

CREATE TABLE IF NOT EXISTS blob_orphan (
  sha256            TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  first_orphaned_at INTEGER NOT NULL CHECK (first_orphaned_at >= 0)
) STRICT;
`;

export const BLOB_CONTENT_ITEM_FTS_DDL = `
DROP TRIGGER IF EXISTS fts_core_content_item_ai;
DROP TRIGGER IF EXISTS fts_core_content_item_au;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_ai AFTER INSERT ON core_content_item BEGIN
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, ${CONTENT_ITEM_SEARCH_TEXT("new")}
   WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_au AFTER UPDATE ON core_content_item BEGIN
  DELETE FROM fts_core_content_item WHERE rowid = old.rowid;
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, ${CONTENT_ITEM_SEARCH_TEXT("new")}
   WHERE new.deleted_at IS NULL;
END;
`;

export const BLOB_FTS_OVERRIDE_DDL = `
-- Rebuild the document's FTS sync derivative-aware (see header).
DROP TRIGGER IF EXISTS fts_core_document_ai;
DROP TRIGGER IF EXISTS fts_core_document_au;
CREATE TRIGGER IF NOT EXISTS fts_core_document_ai AFTER INSERT ON core_document BEGIN
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", ${DOCUMENT_BODY("new")}
   WHERE new."deleted_at" IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS fts_core_document_au AFTER UPDATE ON core_document BEGIN
  DELETE FROM fts_core_document WHERE rowid = old.rowid;
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", ${DOCUMENT_BODY("new")}
   WHERE new."deleted_at" IS NULL;
END;

${BLOB_CONTENT_ITEM_FTS_DDL}

-- Extracted text can arrive AFTER the document already exists (async OCR/
-- text-layer extraction) — refresh whichever document(s) are currently
-- pointed at the derivative's parent content item.
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS("NEW.content_id")}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS("NEW.content_id")}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS("OLD.content_id")}
END;

-- Renamed from trg_fts_content_transcript_* (issue #724 W4/W6): the WHEN
-- clause now covers 'text' as well as 'transcript' (see
-- CONTENT_ITEM_SEARCH_TEXT's header — photo OCR and document text are the
-- same variant, and a non-document content item's OCR text belongs in this
-- generic index too), so the old name would now describe less than the
-- trigger does. Triggers are DDL, not data — DROP + CREATE under a new name
-- is a safe rung, unlike the CHECK-constraint/ADD-COLUMN cases elsewhere in
-- this file that cannot be rewritten in place.
DROP TRIGGER IF EXISTS trg_fts_content_transcript_ai;
DROP TRIGGER IF EXISTS trg_fts_content_transcript_au;
DROP TRIGGER IF EXISTS trg_fts_content_transcript_ad;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_item_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_CONTENT_ITEM_FTS("NEW.content_id")}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_item_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_CONTENT_ITEM_FTS("NEW.content_id")}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_item_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant IN ('text','transcript')
BEGIN${REFRESH_CONTENT_ITEM_FTS("OLD.content_id")}
END;
`;

export const BLOB_DDL = `
CREATE TABLE IF NOT EXISTS blob_staging (
  staging_id    TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  original_name TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  staged_by     TEXT,
  held_by_batch TEXT,
  -- A staged DERIVATIVE rides beside its parent: claimed with it, swept with
  -- it. Generation is producer-agnostic (a client canvas today, a server
  -- codec plug-in later) — the registry doesn't care who downscaled.
  variant       TEXT CHECK (variant IN ('thumb','preview','poster','text','transcript','embedding','phash','thumbhash')),
  variant_of    TEXT CHECK ((variant IS NULL) = (variant_of IS NULL)),
  -- Semantic variants are payloads, not CAS rentals. Their sha remains the
  -- contribution checksum/row identity while the canonical value stays here.
  inline_content TEXT,
  staged_at     TEXT NOT NULL,
  CHECK (variant IS NULL OR
    (variant IN ('thumb','preview','poster') AND inline_content IS NULL) OR
    (variant IN ('text','transcript','embedding','phash','thumbhash') AND inline_content IS NOT NULL))
) STRICT;
-- Originals dedupe by byte identity. Derivatives dedupe by their semantic
-- slot, not their bytes: the same poster can validly belong to two videos,
-- and one UTF-8 payload can validly be both text and transcript.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blob_staging_original_sha
  ON blob_staging(sha256) WHERE variant IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_blob_staging_derivative_slot
  ON blob_staging(variant_of, variant) WHERE variant IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blob_staging_sha ON blob_staging(sha256);

CREATE TABLE core_content_derivative (
  derivative_id TEXT PRIMARY KEY,
  content_id    TEXT NOT NULL
    REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  variant       TEXT NOT NULL CHECK (variant IN ('thumb','preview','poster','text','transcript','embedding','phash','thumbhash')),
  sha256        TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  text_content  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (content_id, variant),
  CHECK ((variant IN ('thumb','preview','poster')) = (sha256 IS NOT NULL)),
  CHECK ((variant IN ('text','transcript','embedding','phash','thumbhash')) = (text_content IS NOT NULL)),
  FOREIGN KEY (derivative_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_derivative_content ON core_content_derivative(content_id);
${touchUpdatedAt("core_content_derivative", "derivative_id")}

-- Custody-state mirror (issue #352 phase 3/4): a rebuildable projection over
-- BlobCustody.statusFor, refreshed wholesale by refreshCustodyState
-- (blob/custody.ts) on every standing blob sweep. Registered as the logical
-- entity blob.custody_state (schema/tables.ts) so apps can read it like any
-- other table — the vault's ONE app-readable window into local-vs-replicated
-- byte custody. Never written by a command; read-only from the app plane by
-- construction (no command targets it).
CREATE TABLE IF NOT EXISTS blob_custody_state (
  content_id    TEXT PRIMARY KEY REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  custody_state TEXT NOT NULL CHECK (custody_state IN ('pending-offsite','local-only','replicated','remote-only','missing')),
  checked_at    TEXT NOT NULL
) STRICT;

-- Custody ROLLUP (issue #711): the aggregate twin of the mirror above, one row
-- per bucket, rebuilt wholesale beside it (blob/custody-rollup.ts). It exists
-- because the aggregate is not computable from the app plane: answering "what
-- do my originals cost, and what could be released?" over the mirror would
-- mean reading every content item (the whole library, bytes included), and the
-- decisive fact — whether the byte is PRESENT in the local CAS — is a
-- filesystem question no app can ask. Registered as blob.custody_rollup.
--
-- The bucket column is a custody state (counted per content item — a
-- photograph is what a member counts) or one of the two local-tier buckets,
-- freeable and local-unproven, counted per distinct sha because deduped
-- content occupies the disk once. The two families never sum together.
--
-- byte_size is exact, not a floor: it sums core_content_item.byte_size, which
-- is NOT NULL, so there is no sizeless remainder to disclose.
CREATE TABLE IF NOT EXISTS blob_custody_rollup (
  bucket      TEXT PRIMARY KEY,
  item_count  INTEGER NOT NULL CHECK (item_count >= 0),
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  computed_at TEXT NOT NULL
) STRICT;

${BLOB_FTS_OVERRIDE_DDL}
${BLOB_CACHE_DDL}`;

export function rebuildDocumentFtsIndex(vault: DatabaseSync): void {
  vault.exec("DELETE FROM fts_core_document;");
  vault.exec(`
    INSERT INTO fts_core_document (rowid, document_id, title, body)
    SELECT d.rowid, d."document_id", d."title", ${DOCUMENT_BODY("d")}
      FROM core_document d
     WHERE d."deleted_at" IS NULL;
  `);
}
