// Enrichment schema (#299, v10): what the enrichment spine adds to the
// model. Deliberately small — derived data lands in tables the ontology
// already has (knowledge_annotation, core_tag, media_face_region,
// core_content_derivative); this migration only adds what no existing table
// carries.
//
// WHAT THIS FILE CREATES, in full — three things, not one:
//
//   1. TEN TABLES and their indexes, in `ENRICH_DDL` — `media_asset_phash`,
//      `media_memory`, `media_memory_member`, `enrich_policy`,
//      `enrich_embedding`, `enrich_derivation`, `enrich_request`,
//      `media_face_cluster`, `enrich_policy_rule` and `enrich_consent`. One
//      bullet each below, in the order that carries the argument for the
//      shape rather than the order the DDL declares.
//   2. GUARDED SEED ROWS, in the same DDL and all four written the same way —
//      `INSERT … SELECT … WHERE NOT EXISTS … AND EXISTS (SELECT 1 FROM
//      core_vault)`, so a fresh, not-yet-bootstrapped file gets none of them
//      and bootstrap never collides with a backfill. They are the `photos`
//      and `docs` rows of `enrich_policy`, and the `vision` and `doctype`
//      rows of `core_concept_scheme` — which is the one table this file
//      writes to WITHOUT creating (the ontology already has it).
//   3. TWO EXPORTED CONSTANTS beneath the DDL, `VISION_SCHEME_URI` and
//      `DOCTYPE_SCHEME_URI`, so the publishers that mint concepts under those
//      schemes name them from here rather than spelling the URI again.
//
// The bullets:
//
//   - `media_asset_phash` — the Tier-0 perceptual hash (#299),
//     producer-agnostic like thumbs: the client canvas computes a dHash
//     today, a server codec plug-in may later. Near-duplicate detection is
//     then plain SQL over `vault_hamming`. The issue sketched a column on
//     media_asset; it ships as a sidecar keyed by asset_id because
//     SQLite's ADD COLUMN cannot be written re-runnably (the migration
//     ladder's de-facto contract — see the v8 rebuild) and a rebuild would
//     cross media_face_region's live FK. Same queries, one JOIN.
//   - `enrich_embedding` — the additive vector index (#299).
//     One row per (entity, model); vectors are little-endian float32 BLOBs.
//     Nothing else depends on it: FTS over captions is the primary search
//     plane, embeddings only ever add recall.
//
//     MODEL IDENTITY CARRIES VERSION (#721). `model` is the string
//     `"<name>@<version>"` — see `enrich/model-id.ts` for the make/parse/
//     compare helpers and the full argument. The consequence for this DDL is
//     that a model upgrade is a BACKFILL, never a migration: re-derive the
//     rows whose parsed version is below the current one and let the UNIQUE
//     (target_type, target_id, model) key hold both generations meanwhile.
//     There is deliberately NO `model_version` column: it would cost a
//     rebuild across media_face_region's live FK (the sidecar argument above)
//     to express what a parseable key already expresses.
//
//     There is likewise no content-hash column, because re-derivation is
//     ALREADY content-stable: a row targets an entity whose content item
//     carries `sha256` and dedupes on it, so re-importing the same bytes
//     lands on the same content row and therefore the same target — nothing
//     to re-key. Different bytes are a different content row with its own
//     derivation. The only thing that invalidates an embedding is the model
//     changing, and the key above records exactly that.
//   - `enrich_derivation` — the provenance stamp (#724): which
//     capability ran, under which model, over which target's which variant,
//     and when. It stores no derived VALUE — the value lands in the table the
//     ontology already has (knowledge_annotation, core_tag,
//     media_face_region, core_content_derivative) — because the missing fact
//     was never the content, it was the PRODUCER.
//
//     WHY IT HAS TO EXIST. Only `enrich_embedding` can answer "which model
//     wrote this row?", because its uniqueness key carries `model`; no other
//     derived table does, and none can grow one (the sidecar argument above).
//     Without a stamp, a gateway upgrading its OCR model has no selector for
//     "the text regions the old model produced" short of re-deriving the
//     library. One stamp per (target, variant) makes the `"<name>@<version>"`
//     convention a selector for EVERY capability.
//
//     ONE STAMP PER (target_type, target_id, variant, profile), enforced by
//     UNIQUE and written by `enrich/derivation.ts`'s upsert. Two stamps for one
//     target's variant are a CONFLICT within a profile and normal ACROSS
//     profiles (#807): a member may keep the built-in OCR result and an
//     LLM profile's result for the same page, and which one an app reads is a
//     policy question answered by `enrich/derivation.ts`'s
//     `preferredDerivation`, not by the key refusing to hold both. Re-running
//     one profile still REPLACES that profile's stamp — within a profile the
//     row must always name the model whose output is on disk right now, which
//     is the ambiguity the stamp exists to remove. (Embeddings keep both model
//     generations, but they keep them in `enrich_embedding`, where the old
//     vectors still answer searches while the new ones fill in.)
//
//     THAT KEY IS WIDENED IN PLACE, never rebuilt: SQLite cannot alter a
//     UNIQUE constraint, and a rebuild would cross the same live FKs. It is
//     free under the edit-in-place schema below, provided the call site holds
//     — `profile` defaults to 'built-in', so a writer that names no profile
//     reads and writes exactly as before.
//
//     `payload_json` is an OPTIONAL, small, JSON-valid echo of what was
//     derived — a region count, a confidence, the variant's byte size — for
//     the operator reading a stuck library, never a second copy of the data.
//   - `enrich_request` — the on-demand priority queue (#299):
//     a search that found nothing, or an owner opening an unenriched item,
//     records what was wanted; enrichers drain this queue before the backlog.
//     `reason` widened with `manual` (#352 phase 3/4): an owner-driven
//     "detect faces now" gesture from an app is neither a search miss nor a
//     passive on-view — it is an explicit ask. Widened again with `projected`
//     (#726): a row that arrived over a share edge is re-registered by
//     the audience's own ingest door (share/projection-ingest.ts), and that
//     signal is neither an owner ask nor a member gesture — it is the vault
//     saying "this item is new HERE". Naming it is what keeps `manual` an
//     owner's word.
//   - `media_asset_phash.cluster_id` (#352 phase 3/4): a rebuildable
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
//     The tier axis is `off|device|gateway` (#712); `enrich/policy.ts` maps
//     the legacy `local|model` tokens at read time. The CHECK below keeps
//     ACCEPTING those tokens: under the edit-in-place schema an existing
//     table keeps the CHECK it was created with, so a legacy value already in
//     a row must stay a legal SELECT. Nothing writes them.
//   - `enrich_policy_rule` — the scoped policy cascade (#807). The tier
//     mirror above answers ONE question per domain ("how far may photos
//     enrichment run"), which cannot say "faces on for Photos but off for the
//     Screenshots album" or "built-in OCR everywhere except this folder". This
//     table is the rule STORE for that cascade: one row per (scope, capability)
//     stating what that scope decides and nothing more, with `NULL` meaning
//     "inherit" so a rule that only names an engine profile does not silently
//     assert enablement. Resolution (most specific wins) belongs to the ONE
//     gate — `packages/server/src/automation/fire/enrich-gate.ts`'s
//     `decideEnrichmentGate` — never to a reader of this table: storage-level
//     accessors that answered "may this run" would be a second policy path.
//     The tier mirror stays authoritative until that resolver absorbs it.
//   - `enrich_consent` — egress consent, keyed capability × egress class
//     (#807), ORTHOGONAL to the cascade above. Policy selects an engine;
//     this says whether that engine's egress class was ever agreed to, so a
//     per-item "use provider X just this once" override can never widen egress
//     by itself. Egress class is a fact about the ENGINE (`on-device` — the
//     member's own devices; `gateway` — their own infrastructure; `provider` —
//     a third party), the same axis `enrich-gate.ts` documents. This table is
//     HISTORY: rung six (#883) folds its rows into the one authority plane as
//     `harness`-principal rows and drops it, so the baseline still creates it
//     only because the rung must have the same table to read on both paths.
//     The live shape is `schema/authority.ts`; the accessors are unchanged
//     (`enrich/egress-consent.ts`).
//   - the `vision` and `doctype` concept schemes — machine-tag vocabularies
//     (#299). Concepts are created on demand by the tag publisher.
//     Fresh vaults seed the schemes at bootstrap; the guarded inserts below
//     backfill vaults that already have an owner (`core_vault` row) — on a
//     fresh, not-yet-bootstrapped file they insert nothing, so bootstrap
//     and `importVaultExport` never collide with them.
//   - `media_memory` / `media_memory_member` (#724 W7, "Memories v0"):
//     a second REBUILDABLE PROJECTION beside the phash cluster_id above, same
//     mold exactly — recomputed wholesale by the standing sweep
//     (`enrich/memories.ts`'s `rebuildMemories`, invoked from
//     `gateway/gateway.ts`'s `sweep()` beside `recomputeDuplicateClusters`),
//     derived, never authored, safe to drop and rebuild from the source
//     tables alone. Three kinds share one table (CHECK'd union) because a
//     member browses them as one list, not three:
//
//       'on-this-day' — assets whose capture-local day (captured_at shifted
//       by tz_offset_min, else the raw UTC slice — there is no viewing device
//       to fall back to server-side) shares a month-day with some OTHER
//       asset from a different year. Grouped by `day_key` ('MM-DD'), NOT by
//       "today" — the sweep has no wall-clock opinion about which day is
//       "today"; a mobile client filters `day_key` down to the current date
//       at READ time (`memories-model.ts`), and the same row serves every day
//       of the year it is asked about. A day with photos from only one year
//       is not a memory of anything and gets no row.
//
//       'trip' — a maximal run of capture-local days whose modal place
//       differs from the owner's home place, gaps of a few empty days
//       bridged rather than fragmented. See `enrich/memories.ts`'s header for
//       the exact thresholds and why they are conservative.
//
//       'similar' — near-duplicate/burst groups: the union (via a second
//       union-find, same technique as `enrich/clusters.ts`) of
//       `media_asset_phash.cluster_id` groups and `capture_group_id` groups,
//       so a Live Photo pair and a burst of near-identical shots both surface
//       as one memory even when only one of the two signals fired.
//
//     HONEST ABSENCE. An asset with NULL `captured_at` can never enter
//     'on-this-day' or 'trip' (both are date-keyed by construction — no day
//     key, no group); it CAN enter 'similar', which keys on phash/capture
//     group identity, not on when the shutter fired. Nothing here fabricates
//     a date for an asset that carries none.
//
//     DETERMINISTIC IDS. `memory_id` composes the kind with the grouping's
//     own stable key — `otd:<day_key>`, `trip:<first away day>` (a day starts
//     at most one trip), `similar:<lowest asset_id>` (the same "lowest id is
//     the identity" rule as `cluster_id`). No `randomblob`, no wall-clock, so
//     "drop every row and reinsert" is byte-stable. `computed_at` is the one
//     column outside every id and equality check — an audit timestamp only.
//   - `media_face_cluster` (#724 W5, "Faces"): the THIRD rebuildable
//     projection in this file, same mold as the two above — recomputed
//     wholesale by `enrich/face-clusters.ts` on the standing sweep, derived,
//     never authored, safe to drop and rebuild from `media_face_region` +
//     `enrich_embedding` alone.
//
//     PARTY-ANCHORED: IDENTITY IS NOT IN THIS TABLE. Only
//     `media_face_region.party_id` and `.confirmed_by_party_id` ever name a
//     person. A cluster id is the opposite kind of fact — an EPHEMERAL
//     grouping of faces nobody has named, offered to the member as "name this
//     one" and gone once they do. Never stored on a region, never rendered as
//     a person, never compared across runs except for display stability.
//
//     Deterministic ids, same rule as above: a group's `cluster_id` is the
//     LOWEST `region_id` in it, so unchanged membership never shuffles the id
//     a shelf displays.

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

/** Scheme URIs the enrichment publishers create concepts under. */
export const VISION_SCHEME_URI = "urn:centraid:vision";
export const DOCTYPE_SCHEME_URI = "urn:centraid:doctype";
