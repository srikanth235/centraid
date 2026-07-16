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
// variants exist is model. Binary variants (thumb/preview/poster) live in
// the CAS under their own sha; semantic variants live INLINE in
// `text_content` so text/transcripts can feed FTS in-transaction and
// embeddings/perceptual hashes never masquerade as rentable blob bytes
// in-transaction — the same no-I/O constraint that keeps text/* bodies
// inline (issue #296 §1) applies to the index feed.
//
// A match inside a PDF must surface the DOCUMENT (issue #352: core_document,
// not the raw content item), so extracted text feeds the OWNING document's
// FTS row rather than a shadow row. The v2 triggers rebuilt the row from
// `vault_content_text` alone — any title rename would clobber derivative
// text — so this recreates them with the derivative-aware body expression,
// and mirrors it from the derivative side. A content item can be the
// current body of more than one document (sha256 dedup, or two documents
// deliberately sharing bytes) — the refresh fans out to every one of them.
//
// Extracted text (`core_content_derivative.text_content`, async OCR/text
// layer) is the one FTS feed with no upstream size gate of its own — the
// per-document index budget (issue #367 §E3, `truncateForIndex`) applies
// here too, same as every other body-shaped column.

import type { DatabaseSync } from 'node:sqlite';
import { truncateForIndex } from './fts.js';

/** Body of a document's FTS row: extracted text, transcript, inline text. */
const DOCUMENT_BODY = (ref: string) =>
  truncateForIndex(`COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."current_content_id" AND dv.variant = 'transcript'),
    (SELECT vault_content_text(ci."media_type", ci."content_uri") FROM core_content_item ci
      WHERE ci.content_id = ${ref}."current_content_id"))`);

/** Core content search text: the owner's title plus spoken-word transcript. */
const CONTENT_ITEM_SEARCH_TEXT = (ref: string) =>
  truncateForIndex(`trim(COALESCE(${ref}."title", '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = ${ref}."content_id" AND dv.variant = 'transcript'), ''))`);

const REFRESH_DOCUMENT_FTS = (contentIdRef: string) => `
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = ${contentIdRef});
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", ${DOCUMENT_BODY('d')}
    FROM core_document d
   WHERE d.current_content_id = ${contentIdRef} AND d."deleted_at" IS NULL;`;

const REFRESH_CONTENT_ITEM_FTS = (contentIdRef: string) => `
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = ${contentIdRef});
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, ${CONTENT_ITEM_SEARCH_TEXT('i')}
    FROM core_content_item i
   WHERE i.content_id = ${contentIdRef} AND i.deleted_at IS NULL;`;

// Bounded-storage-tier cache tables (issue #405 §3/§4). Deliberately
// SELF-CONTAINED — no FKs into the core spine, no triggers — so a test can
// create them on a bare `:memory:` handle without the whole migration ladder,
// and so they are pure plumbing (like `blob_staging`, NOT registered logical
// entities the app plane can read).
//
//   blob_replica — the DURABLE replication index (§4): one row per sha we have
//     pushed to the remote tier and got a 2xx back for. This is the local
//     EVIDENCE that a copy exists off-disk; `statusFor()`/`replicate()` read it
//     instead of a live `remote.list()` (which is O(all-objects) — 100+ round
//     trips per sweep at 500 GB). It is a CACHE of evidence, not truth: the
//     remote listing is truth, and `reconcile()`'s deep pass heals this table
//     from it. Evict-only-if-replicated (§3) consults THIS table — durable
//     proof we replicated — never a live listing.
//
//   blob_access — LRU access tracking (§3): last-access time per sha, so the
//     eviction pass can evict least-recently-used mediums/originals first. The
//     hot sync read path (`getSync`/`open`) must NEVER pay a synchronous SQLite
//     write per read, so touches accumulate in an in-memory write-behind Map
//     (blob/replica-index.ts `AccessIndex`) and flush at sweep time. The
//     staleness trade-off: a blob read since the last flush may sort older than
//     it truly is until the next flush — acceptable, because eviction only runs
//     at sweep boundaries (which flush first) and cache pressure, not per read.
//     A sha with no row sorts OLDEST (never touched since it landed).
export const BLOB_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS blob_replica (
  sha256        TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  replicated_at TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS blob_access (
  sha256         TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  last_access_at TEXT NOT NULL,
  byte_size      INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_blob_access_lru ON blob_access(last_access_at);
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

CREATE TABLE IF NOT EXISTS core_content_derivative (
  derivative_id TEXT PRIMARY KEY,
  content_id    TEXT NOT NULL REFERENCES core_content_item(content_id),
  variant       TEXT NOT NULL CHECK (variant IN ('thumb','preview','poster','text','transcript','embedding','phash','thumbhash')),
  sha256        TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  media_type    TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  text_content  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (content_id, variant),
  CHECK ((variant IN ('thumb','preview','poster')) = (sha256 IS NOT NULL)),
  CHECK ((variant IN ('text','transcript','embedding','phash','thumbhash')) = (text_content IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_derivative_content ON core_content_derivative(content_id);

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

-- Rebuild the document's FTS sync derivative-aware (see header).
DROP TRIGGER IF EXISTS fts_core_document_ai;
DROP TRIGGER IF EXISTS fts_core_document_au;
CREATE TRIGGER IF NOT EXISTS fts_core_document_ai AFTER INSERT ON core_document BEGIN
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", ${DOCUMENT_BODY('new')}
   WHERE new."deleted_at" IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS fts_core_document_au AFTER UPDATE ON core_document BEGIN
  DELETE FROM fts_core_document WHERE rowid = old.rowid;
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", ${DOCUMENT_BODY('new')}
   WHERE new."deleted_at" IS NULL;
END;

-- A video's/audio file's transcript is searched through the same canonical
-- content item the Photos projection already joins. The existing FTS table
-- has one indexed title column, so its value is the visible title plus the
-- bounded transcript; no second shadow/search path is introduced.
DROP TRIGGER IF EXISTS fts_core_content_item_ai;
DROP TRIGGER IF EXISTS fts_core_content_item_au;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_ai AFTER INSERT ON core_content_item BEGIN
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, ${CONTENT_ITEM_SEARCH_TEXT('new')}
   WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS fts_core_content_item_au AFTER UPDATE ON core_content_item BEGIN
  DELETE FROM fts_core_content_item WHERE rowid = old.rowid;
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, ${CONTENT_ITEM_SEARCH_TEXT('new')}
   WHERE new.deleted_at IS NULL;
END;

-- Extracted text can arrive AFTER the document already exists (async OCR/
-- text-layer extraction) — refresh whichever document(s) are currently
-- pointed at the derivative's parent content item.
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_document_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant IN ('text','transcript')
BEGIN${REFRESH_DOCUMENT_FTS('OLD.content_id')}
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_content_transcript_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant = 'transcript'
BEGIN${REFRESH_CONTENT_ITEM_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_transcript_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant = 'transcript'
BEGIN${REFRESH_CONTENT_ITEM_FTS('NEW.content_id')}
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_content_transcript_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant = 'transcript'
BEGIN${REFRESH_CONTENT_ITEM_FTS('OLD.content_id')}
END;
${BLOB_CACHE_DDL}`;

/**
 * Rebuild path for `fts_core_document` (issue #367 §E3) — the
 * `core.document` counterpart to `rebuildFtsIndex` (schema/fts.ts), which
 * explicitly refuses this entity because the generic backfill doesn't know
 * about the derivative-aware body expression above. Re-derives every live
 * document's row from scratch (extracted text still wins over the raw
 * decode), so a `FTS_BODY_INDEX_BUDGET_CHARS` change reflows documents too.
 */
export function rebuildDocumentFtsIndex(vault: DatabaseSync): void {
  vault.exec('DELETE FROM fts_core_document;');
  vault.exec(`
    INSERT INTO fts_core_document (rowid, document_id, title, body)
    SELECT d.rowid, d."document_id", d."title", ${DOCUMENT_BODY('d')}
      FROM core_document d
     WHERE d."deleted_at" IS NULL;
  `);
}
