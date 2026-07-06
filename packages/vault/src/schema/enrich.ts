// Enrichment schema (issue #299, v10): what the enrichment spine adds to the
// model. Deliberately small — derived data lands in tables the ontology
// already has (knowledge_annotation, core_tag, media_face_region,
// core_content_derivative); this migration only adds what no existing table
// carries:
//
//   - `media_asset_phash` — the Tier-0 perceptual hash (issue #299 §2),
//     producer-agnostic like thumbs: the client canvas computes a dHash
//     today, a server codec plug-in may later. Near-duplicate detection is
//     then plain SQL over `vault_hamming`. The issue sketched a column on
//     media_media_asset; it ships as a sidecar keyed by asset_id because
//     SQLite's ADD COLUMN cannot be written re-runnably (the migration
//     ladder's de-facto contract — see the v8 rebuild) and a rebuild would
//     cross media_face_region's live FK. Same queries, one JOIN.
//   - `enrich_embedding` — the additive vector index (issue #299 phase 5).
//     One row per (entity, model); vectors are little-endian float32 BLOBs.
//     Nothing else depends on it: FTS over captions is the primary search
//     plane, embeddings only ever add recall.
//   - `enrich_request` — the on-demand priority queue (issue #299 phase 5):
//     a search that found nothing, or an owner opening an unenriched item,
//     records what was wanted; enrichers drain this queue before the backlog.
//   - the `vision` and `doctype` concept schemes — machine-tag vocabularies
//     (issue #299 §4). Concepts are created on demand by the tag publisher.
//     Fresh vaults seed the schemes at bootstrap; the guarded inserts below
//     backfill vaults that already have an owner (`core_vault` row) — on a
//     fresh, not-yet-bootstrapped file they insert nothing, so bootstrap
//     and `importVaultExport` never collide with them.

export const ENRICH_DDL = `
CREATE TABLE IF NOT EXISTS media_asset_phash (
  asset_id TEXT PRIMARY KEY REFERENCES media_media_asset(asset_id) ON DELETE CASCADE,
  phash    TEXT NOT NULL CHECK (length(phash) BETWEEN 4 AND 64),
  computed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS enrich_embedding (
  embedding_id TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL CHECK (dim > 0),
  vector       BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, model)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_embedding_entity
  ON enrich_embedding(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS enrich_request (
  request_id   TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  reason       TEXT NOT NULL CHECK (reason IN ('search-miss','on-view')),
  detail       TEXT,
  requested_at TEXT NOT NULL,
  drained_at   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_request_open
  ON enrich_request(entity_type, requested_at) WHERE drained_at IS NULL;

INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
SELECT lower(hex(randomblob(16))), 'urn:centraid:vision', 'Vision tags (machine)', 'centraid', '1'
 WHERE NOT EXISTS (SELECT 1 FROM core_concept_scheme WHERE uri = 'urn:centraid:vision')
   AND EXISTS (SELECT 1 FROM core_vault);

INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
SELECT lower(hex(randomblob(16))), 'urn:centraid:doctype', 'Document types (machine)', 'centraid', '1'
 WHERE NOT EXISTS (SELECT 1 FROM core_concept_scheme WHERE uri = 'urn:centraid:doctype')
   AND EXISTS (SELECT 1 FROM core_vault);
`;

/** Scheme URIs the enrichment publishers create concepts under. */
export const VISION_SCHEME_URI = 'urn:centraid:vision';
export const DOCTYPE_SCHEME_URI = 'urn:centraid:doctype';
