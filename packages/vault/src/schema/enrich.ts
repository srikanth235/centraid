import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const ENRICH_DDL = `
CREATE TABLE media_asset_phash (
  asset_id TEXT PRIMARY KEY REFERENCES media_asset(asset_id) ON DELETE CASCADE,
  phash    TEXT NOT NULL CHECK (length(phash) BETWEEN 4 AND 64),
  -- Near-duplicate cluster projection (issue #352 phase 3/4) — see header.
  cluster_id  TEXT,
  computed_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_asset_phash_cluster
  ON media_asset_phash(cluster_id) WHERE cluster_id IS NOT NULL;

-- Memories v0 (issue #724 W7) — see the header above for the three kinds,
-- the honest-absence rule, and the deterministic-id scheme.
CREATE TABLE media_memory (
  memory_id   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('on-this-day','trip','similar')),
  -- A cheap, join-free hint the shelf can print without a second query — see
  -- the header above for which kinds populate it and why the rest stay NULL
  -- rather than duplicating a name/count the member's own joins already have.
  title_hint  TEXT,
  -- 'MM-DD', 'on-this-day' rows only.
  day_key     TEXT CHECK (kind = 'on-this-day' OR day_key IS NULL),
  -- The trip's modal AWAY place. 'trip' rows only.
  place_id    TEXT REFERENCES core_place(place_id) ON DELETE SET NULL
                CHECK (kind = 'trip' OR place_id IS NULL),
  started_at  TEXT,
  ended_at    TEXT,
  computed_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_memory_kind ON media_memory(kind);
CREATE INDEX IF NOT EXISTS idx_media_memory_day_key
  ON media_memory(day_key) WHERE day_key IS NOT NULL;
-- Covers the place_id -> core_place FK child column (schema/fk-index.test.ts)
-- as well as "which trips visited this place" lookups.
CREATE INDEX IF NOT EXISTS idx_media_memory_place
  ON media_memory(place_id) WHERE place_id IS NOT NULL;

CREATE TABLE media_memory_member (
  memory_id TEXT NOT NULL REFERENCES media_memory(memory_id) ON DELETE CASCADE,
  asset_id  TEXT NOT NULL REFERENCES media_asset(asset_id) ON DELETE CASCADE,
  -- Display order within the memory (capture order). Not UNIQUE per memory:
  -- ties (same captured_at) share an ordinal rather than an arbitrary
  -- tiebreak deciding which photo "comes first".
  ordinal   INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (memory_id, asset_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_memory_member_asset
  ON media_memory_member(asset_id);

CREATE TABLE enrich_policy (
  domain     TEXT PRIMARY KEY CHECK (domain IN ('photos','docs')),
  -- 'local' and 'model' are the pre-#712 tier names, kept legal here as a
  -- read compatibility shim only — see the header comment above.
  tier       TEXT NOT NULL CHECK (tier IN ('off','device','gateway','local','model')),
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
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

CREATE TABLE enrich_embedding (
  embedding_id TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL CHECK (dim > 0),
  vector       BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id, model),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_embedding_entity
  ON enrich_embedding(target_type, target_id);

CREATE TABLE enrich_derivation (
  derivation_id TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  -- What was produced ('caption', 'text', 'faces', 'transcript', …) — the
  -- same vocabulary the value's own table uses, deliberately not CHECKed:
  -- a capability shipped after this DDL must be stampable without a rebuild.
  variant       TEXT NOT NULL,
  capability    TEXT NOT NULL,
  -- Which ENGINE PROFILE produced this row (issue #807): the named bundle of
  -- capability + engine + parameters the member pointed policy at. Deliberately
  -- not CHECKed, for the reason variant is not: a profile is a runtime object
  -- users create, and the DDL must never be the thing that refuses one. The
  -- DEFAULT is the identity of the bundled deterministic engines, so a call
  -- site that names no profile keeps writing exactly the row it wrote before.
  profile       TEXT NOT NULL DEFAULT 'built-in',
  -- '<name>@<version>' (enrich/model-id.ts). An unparseable value is legal to
  -- STORE and simply never matches a backfill query — the same stance
  -- enrich_embedding.model takes toward a row written by a foreign build.
  model         TEXT NOT NULL,
  payload_json  TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  produced_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id, variant, profile),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
-- The backfill selector's index: "everything this capability produced under
-- some model", which is the query a version bump asks of the whole library.
CREATE INDEX IF NOT EXISTS idx_enrich_derivation_model
  ON enrich_derivation(capability, model);

CREATE TABLE enrich_request (
  request_id          TEXT PRIMARY KEY,
  target_type         TEXT NOT NULL,
  target_id           TEXT,
  -- 'projected' is minted by the vault itself (share/projection-ingest.ts) and
  -- never by a caller: the owner command's enum stays the three human reasons.
  -- It always carries required_capability NULL, so such a row is not leaseable
  -- to a paired device and the device lane's reason vocabulary is unchanged.
  reason              TEXT NOT NULL CHECK (reason IN ('search-miss','on-view','manual','projected')),
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
         OR required_capability IS NOT NULL),
  -- \`target_id\` stays NULLable — a search-miss names a TYPE and no row — so
  -- the composite key is enforced only when both halves are present, which is
  -- SQLite's MATCH SIMPLE default (#916).
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_enrich_request_open
  ON enrich_request(target_type, requested_at) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enrich_request_capability
  ON enrich_request(capability, target_type, requested_at)
  WHERE drained_at IS NULL AND capability IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrich_request_leaseable
  ON enrich_request(required_capability, lease_expires_at, requested_at)
  WHERE drained_at IS NULL AND required_capability IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrich_request_target
  ON enrich_request(target_type, target_id);

INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
SELECT lower(hex(randomblob(16))), 'urn:centraid:vision', 'Vision tags (machine)', 'centraid', '1'
 WHERE NOT EXISTS (SELECT 1 FROM core_concept_scheme WHERE uri = 'urn:centraid:vision')
   AND EXISTS (SELECT 1 FROM core_vault);

INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
SELECT lower(hex(randomblob(16))), 'urn:centraid:doctype', 'Document types (machine)', 'centraid', '1'
 WHERE NOT EXISTS (SELECT 1 FROM core_concept_scheme WHERE uri = 'urn:centraid:doctype')
   AND EXISTS (SELECT 1 FROM core_vault);

-- ─── issue #724 W5 (Faces) ────────────────────────────────────────────────
-- Kept as one delimited block at the END of this DDL so the three #724
-- workstreams editing this file do not collide textually. Nothing above
-- depends on it.
--
-- The unnamed-face grouping projection. See the header above for why identity
-- is NOT here (it lives in media_face_region.party_id / core_party) and why
-- this table is safe to recompute wholesale.
CREATE TABLE media_face_cluster (
  -- One row per grouped region — a region is in at most one cluster, so the
  -- region is the key and "not in this table" is the honest way to say a face
  -- is ungrouped (named, answered, or alone). No nullable cluster column, no
  -- singleton rows: absence is the absence, not a NULL to interpret.
  region_id   TEXT PRIMARY KEY REFERENCES media_face_region(region_id) ON DELETE CASCADE,
  -- The group's LOWEST region_id (deterministic — see the header).
  cluster_id  TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
CREATE INDEX IF NOT EXISTS idx_media_face_cluster_cluster
  ON media_face_cluster(cluster_id);
-- ─── end issue #724 W5 ────────────────────────────────────────────────────

-- ─── issue #807 (generic enrichment) ──────────────────────────────────────
-- The policy cascade's rule store. The egress-consent ledger it shipped beside
-- is gone (#883, ruling V-table): an egress answer is an answer like any other
-- and lives in \`share_authority\` as a 'harness' principal. No reader of this
-- table decides whether work may run — decideEnrichmentGate stays the one gate.
CREATE TABLE enrich_policy_rule (
  rule_id    TEXT PRIMARY KEY,
  -- The cascade levels, least to most specific. scope_type names a LEVEL,
  -- not an ontology entity, so (scope_type, scope_ref) is deliberately NOT
  -- the vault's polymorphic (X_type, X_id) shape and is not swept on purge
  -- (schema/entity-refs.ts): a rule whose collection is gone matches no item the
  -- resolver ever walks, so it is inert rather than dangling.
  scope_type TEXT NOT NULL CHECK (scope_type IN ('vault','domain','collection','item')),
  -- '' at vault scope; the domain name, collection id, or target id below it.
  -- Empty string rather than NULL because SQLite treats NULLs as DISTINCT in a
  -- UNIQUE index, which would let a vault-scope rule be written twice.
  scope_ref  TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  -- All three are NULLABLE and mean INHERIT when NULL — a rule states only
  -- what its scope decides. A row that decides nothing is not a rule, so the
  -- CHECK below makes the empty one unrepresentable rather than merely useless.
  enabled    INTEGER CHECK (enabled IS NULL OR enabled IN (0,1)),
  profile    TEXT,
  trigger_on TEXT CHECK (trigger_on IS NULL
    OR trigger_on IN ('on-ingest','on-view','on-demand')),
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  CHECK ((scope_type = 'vault') = (scope_ref = '')),
  CHECK (enabled IS NOT NULL OR profile IS NOT NULL OR trigger_on IS NOT NULL),
  UNIQUE (scope_type, scope_ref, capability)
) STRICT;
-- "Every rule that mentions this capability" — the audit view's query, and the
-- one a capability's removal would have to walk.
CREATE INDEX IF NOT EXISTS idx_enrich_policy_rule_capability
  ON enrich_policy_rule(capability);

-- ─── end issue #807 ───────────────────────────────────────────────────────
${touchUpdatedAt("media_asset_phash", "asset_id")}
${touchUpdatedAt("media_face_cluster", "region_id")}
${touchUpdatedAt("enrich_policy", "domain")}
${touchUpdatedAt("enrich_policy_rule", "rule_id")}
`;

export const VISION_SCHEME_URI = "urn:centraid:vision";
export const DOCTYPE_SCHEME_URI = "urn:centraid:doctype";
