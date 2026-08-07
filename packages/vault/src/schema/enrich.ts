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
//
//     MODEL IDENTITY CARRIES VERSION (issue #721 E1). `model` is the string
//     `"<name>@<version>"` — see `enrich/model-id.ts` for the make/parse/
//     compare helpers and the full argument. The consequence for this DDL is
//     that a model upgrade is a BACKFILL, never a migration: re-derive the
//     rows whose parsed version is below the current one and let the UNIQUE
//     (target_type, target_id, model) key hold both generations meanwhile.
//     There is deliberately NO `model_version` column — SQLite's ADD COLUMN
//     cannot be written re-runnably (see the sidecar argument above), so the
//     column would have cost a rebuild across media_face_region's live FK to
//     express something a parseable key already expresses exactly.
//
//     There is likewise no content-hash column, because re-derivation is
//     ALREADY content-stable: a row targets an entity whose content item
//     carries `sha256` and dedupes on it, so re-importing the same bytes
//     lands on the same content row and therefore the same target — nothing
//     to re-key. Different bytes are a different content row with its own
//     derivation. The only thing that invalidates an embedding is the model
//     changing, and the key above records exactly that.
//   - `enrich_request` — the on-demand priority queue (issue #299 phase 5):
//     a search that found nothing, or an owner opening an unenriched item,
//     records what was wanted; enrichers drain this queue before the backlog.
//     `reason` widened with `manual` (issue #352 phase 3/4): an owner-driven
//     "detect faces now" gesture from an app is neither a search miss nor a
//     passive on-view — it is an explicit ask.
//   - `media_asset_phash.cluster_id` (issue #352 phase 3/4): a rebuildable
//     near-duplicate-cluster projection over the Tier-0 phash sidecar — the
//     standing sweep (gateway/duties.ts via enrich/clusters.ts) groups LIVE
//     assets whose phash hamming distance is <= 6 and stamps the group's
//     lowest asset_id as a stable cluster_id; singletons carry NULL. Derived,
//     never authored — a rebuild from `media_asset_phash` + `vault_hamming`
//     alone reproduces it, so it is safe to recompute wholesale every sweep.
//   - `enrich_policy` — a queryable MIRROR of the owner's per-domain
//     enrichment tier (`core_vault.settings_json.enrich`, host.ts
//     readEnrichSettings/updateEnrichSettings). The settings bag itself is
//     owner-only (GET/PATCH /centraid/_vault/enrich); apps have no reach into
//     JSON settings fields through the consent-checked read path, so this
//     table is the one column of it apps may read — "how far may
//     photos/docs enrichment run: off | device | gateway" — kept in sync by
//     updateEnrichSettings on every owner change, seeded at bootstrap and
//     backfilled below for vaults that predate this table.
//
//     TIER RENAME (issue #712 C5): `off|local|model` became
//     `off|device|gateway` — see `packages/automation/src/fire/enrich-gate.ts`
//     for the axis and `packages/vault/src/enrich/policy.ts` for the
//     COMPAT read-time mapping of legacy stored values. The CHECK below
//     keeps accepting the legacy tokens: this is a pre-release,
//     single-rung, edit-in-place schema (`schema/migrate.ts`), so an
//     already-created `enrich_policy` table keeps whatever CHECK it was
//     created with regardless of what this DDL text says now, and a
//     legacy value already sitting in such a row must stay a legal SELECT
//     forever — only application code translates it. Nothing in this
//     runtime writes the legacy tokens; the CHECK simply refuses to be the
//     thing that turns an old row unreadable.
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
  -- Near-duplicate cluster projection (issue #352 phase 3/4) — see header.
  cluster_id  TEXT,
  computed_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_asset_phash_cluster
  ON media_asset_phash(cluster_id) WHERE cluster_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS enrich_policy (
  domain     TEXT PRIMARY KEY CHECK (domain IN ('photos','docs')),
  -- 'local' and 'model' are the pre-#712 tier names, kept legal here as a
  -- read compatibility shim only — see the header comment above.
  tier       TEXT NOT NULL CHECK (tier IN ('off','device','gateway','local','model')),
  updated_at TEXT NOT NULL
) STRICT;
-- Backfill for vaults that predate this table (bootstrap seeds fresh ones);
-- guarded the same way as the vision/doctype schemes below.
INSERT INTO enrich_policy (domain, tier, updated_at)
SELECT 'photos', 'gateway', datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM enrich_policy WHERE domain = 'photos')
   AND EXISTS (SELECT 1 FROM core_vault);
INSERT INTO enrich_policy (domain, tier, updated_at)
SELECT 'docs', 'gateway', datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM enrich_policy WHERE domain = 'docs')
   AND EXISTS (SELECT 1 FROM core_vault);

CREATE TABLE IF NOT EXISTS enrich_embedding (
  embedding_id TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL CHECK (dim > 0),
  vector       BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id, model)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_embedding_entity
  ON enrich_embedding(target_type, target_id);

CREATE TABLE IF NOT EXISTS enrich_request (
  request_id          TEXT PRIMARY KEY,
  target_type         TEXT NOT NULL,
  target_id           TEXT,
  reason              TEXT NOT NULL CHECK (reason IN ('search-miss','on-view','manual')),
  detail              TEXT,
  -- NULL capability = the existing gateway/automation queue. A named
  -- capability makes the request eligible for an opted-in device lease.
  required_capability TEXT CHECK (required_capability IN
    ('previews','poster','pdfText','ocr','transcript','embedding')),
  contribution_variant TEXT CHECK (contribution_variant IN
    ('thumb','preview','poster','text','transcript','embedding','phash','thumbhash')),
  -- CONSENT SCOPE: which enricher capability this request is FOR, matching
  -- an automation manifest's enrich.capability ("faces", "captions", ...).
  -- The problem it solves: the owner's on-demand ask used to be untagged, so
  -- a face-detection consent handed the SAME queue row to every enabled
  -- enricher: every one of them treated a member's "detect faces" as its own
  -- cue. A tagged row is drained only by the enricher that owns that
  -- capability.
  -- NULL is reserved for the system signals (search-miss / on-view), which
  -- are not consent and stay broadcast; the CHECK below makes an untagged
  -- OWNER ask impossible rather than merely discouraged.
  capability          TEXT CHECK (capability IS NULL
    OR length(capability) BETWEEN 1 AND 64),
  requested_at        TEXT NOT NULL,
  drained_at          TEXT,
  lease_device_id     TEXT,
  lease_token         TEXT,
  lease_expires_at    TEXT,
  lease_attempts      INTEGER NOT NULL DEFAULT 0 CHECK (lease_attempts >= 0),
  CHECK ((lease_device_id IS NULL) = (lease_token IS NULL)),
  CHECK ((lease_device_id IS NULL) = (lease_expires_at IS NULL)),
  -- An owner-driven ask must name a SCOPE — either the enricher capability
  -- it consents to (see capability, the app/automation lane) or the device
  -- capability it is queued for (required_capability, the on-device lease
  -- lane, which is already scoped by the work a device claims). An untagged
  -- manual row is the shape that turned one consent into consent for every
  -- enabled enricher, and it is now unrepresentable.
  CHECK (reason <> 'manual'
         OR capability IS NOT NULL
         OR required_capability IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_request_open
  ON enrich_request(target_type, requested_at) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enrich_request_capability
  ON enrich_request(capability, target_type, requested_at)
  WHERE drained_at IS NULL AND capability IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrich_request_leaseable
  ON enrich_request(required_capability, lease_expires_at, requested_at)
  WHERE drained_at IS NULL AND required_capability IS NOT NULL;

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
export const VISION_SCHEME_URI = "urn:centraid:vision";
export const DOCTYPE_SCHEME_URI = "urn:centraid:doctype";
