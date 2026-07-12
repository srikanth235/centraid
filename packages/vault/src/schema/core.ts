// Canonical core spine DDL — schema `core` from duaility-ontology.html §03.
// SQLite has no namespaces, so logical `core.party` is physical `core_party`;
// the gateway translates logical names (used in grants, receipts, links) to
// physical ones. All tables STRICT; PKs are TEXT UUIDv7; money is fixed-scale
// INTEGER minor units; timestamps are TEXT ISO-8601 UTC.
//
// Cross-file references (into journal.db, e.g. link.provenance_id →
// consent.provenance) carry no REFERENCES clause — the gateway enforces them
// (§10 S4), exactly like polymorphic (type,id) pairs.

export const CORE_DDL = `
CREATE TABLE core_vault (
  vault_id        TEXT PRIMARY KEY,
  owner_party_id  TEXT REFERENCES core_party(party_id),
  display_name    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','locked','exported')),
  base_currency   TEXT NOT NULL CHECK (length(base_currency) = 3),
  settings_json   TEXT NOT NULL CHECK (json_valid(settings_json)),
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_vault_owner_party ON core_vault(owner_party_id);

CREATE TABLE core_party (
  party_id          TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('person','org','group','agent')),
  display_name      TEXT NOT NULL,
  sort_name         TEXT,
  birth_date        TEXT,
  avatar_content_id TEXT REFERENCES core_content_item(content_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  ontology_version  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_party_avatar_content ON core_party(avatar_content_id);

CREATE TABLE core_party_identifier (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  scheme        TEXT NOT NULL CHECK (scheme IN ('email','tel','url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  UNIQUE (scheme, value)
) STRICT;
CREATE UNIQUE INDEX idx_party_identifier_primary
  ON core_party_identifier(party_id, scheme) WHERE is_primary = 1;

CREATE TABLE core_place (
  place_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT CHECK (kind IN ('home','work','venue','city','region','virtual','other')),
  geo_lat         REAL CHECK (geo_lat BETWEEN -90 AND 90),
  geo_lng         REAL CHECK (geo_lng BETWEEN -180 AND 180),
  geohash         TEXT,
  address_json    TEXT CHECK (address_json IS NULL OR json_valid(address_json)),
  tz              TEXT,
  parent_place_id TEXT REFERENCES core_place(place_id),
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_place_parent_place ON core_place(parent_place_id);

CREATE TABLE core_event (
  event_id           TEXT PRIMARY KEY,
  ical_uid           TEXT UNIQUE,
  summary            TEXT NOT NULL,
  description        TEXT,
  dtstart            TEXT NOT NULL,
  dtend              TEXT CHECK (dtend IS NULL OR dtend >= dtstart),
  start_tz           TEXT,
  rrule              TEXT,
  status             TEXT NOT NULL CHECK (status IN ('confirmed','tentative','cancelled')),
  location_place_id  TEXT REFERENCES core_place(place_id),
  organizer_party_id TEXT REFERENCES core_party(party_id),
  sequence           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_event_location_place ON core_event(location_place_id);
CREATE INDEX IF NOT EXISTS idx_event_organizer_party ON core_event(organizer_party_id);

CREATE TABLE core_account (
  account_id           TEXT PRIMARY KEY,
  owner_party_id       TEXT NOT NULL REFERENCES core_party(party_id),
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('depository','credit','investment','loan','cash','wallet')),
  currency             TEXT NOT NULL CHECK (length(currency) = 3),
  institution_party_id TEXT REFERENCES core_party(party_id),
  external_ref         TEXT,
  is_asset             INTEGER NOT NULL CHECK (is_asset IN (0,1)),
  opened_at            TEXT,
  closed_at            TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_account_owner_party ON core_account(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_account_institution_party ON core_account(institution_party_id);

CREATE TABLE core_transaction (
  txn_id                TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES core_account(account_id),
  posted_at             TEXT NOT NULL,
  amount_minor          INTEGER NOT NULL,
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  direction             TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  status                TEXT NOT NULL CHECK (status IN ('pending','posted','void')),
  transfer_group_id     TEXT,
  counterparty_party_id TEXT REFERENCES core_party(party_id),
  description           TEXT,
  category_concept_id   TEXT REFERENCES core_concept(concept_id),
  external_id           TEXT UNIQUE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transaction_account ON core_transaction(account_id);
CREATE INDEX IF NOT EXISTS idx_transaction_counterparty_party ON core_transaction(counterparty_party_id);
CREATE INDEX IF NOT EXISTS idx_transaction_category_concept ON core_transaction(category_concept_id);

CREATE TABLE core_content_item (
  content_id       TEXT PRIMARY KEY,
  media_type       TEXT NOT NULL,
  content_uri      TEXT NOT NULL,
  sha256           TEXT NOT NULL UNIQUE,
  byte_size        INTEGER NOT NULL CHECK (byte_size >= 0),
  title            TEXT,
  language         TEXT,
  creator_party_id TEXT REFERENCES core_party(party_id),
  origin_device_id TEXT REFERENCES consent_device(device_id),
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_item_creator_party ON core_content_item(creator_party_id);
CREATE INDEX IF NOT EXISTS idx_content_item_origin_device ON core_content_item(origin_device_id);

-- A document's identity is separate from its bytes (issue #352): the
-- wrapper is the row apps and links address; current_content_id repoints on
-- edit exactly like knowledge_note.body_content_id. NOT UNIQUE — two
-- documents may legitimately share identical bytes (a template re-used
-- twice). Version lineage is a 'revises' core.link between content items,
-- never a column here — content_item is the version, core.link is history.
CREATE TABLE core_document (
  document_id         TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  current_content_id  TEXT NOT NULL REFERENCES core_content_item(content_id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  purge_at            TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_document_current_content ON core_document(current_content_id);

CREATE TABLE core_attachment (
  attachment_id TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  content_id    TEXT NOT NULL REFERENCES core_content_item(content_id),
  role          TEXT NOT NULL CHECK (role IN ('photo','manual','receipt','warranty','contract','embed','other')),
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attachment_content ON core_attachment(content_id);

CREATE TABLE core_activity (
  activity_id       TEXT PRIMARY KEY,
  actor_party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  kind_concept_id   TEXT NOT NULL REFERENCES core_concept(concept_id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT CHECK (ended_at IS NULL OR ended_at >= started_at),
  location_place_id TEXT REFERENCES core_place(place_id),
  source_app_id     TEXT REFERENCES consent_app(app_id),
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_actor_party ON core_activity(actor_party_id);
CREATE INDEX IF NOT EXISTS idx_activity_kind_concept ON core_activity(kind_concept_id);
CREATE INDEX IF NOT EXISTS idx_activity_location_place ON core_activity(location_place_id);
CREATE INDEX IF NOT EXISTS idx_activity_source_app ON core_activity(source_app_id);

CREATE TABLE core_observation (
  observation_id   TEXT PRIMARY KEY,
  subject_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  code             TEXT NOT NULL,
  value_num        REAL,
  value_text       TEXT,
  unit             TEXT,
  observed_at      TEXT NOT NULL,
  effective_start  TEXT,
  effective_end    TEXT CHECK (effective_end IS NULL OR effective_end >= effective_start),
  statistic        TEXT CHECK (statistic IN ('average','median','minimum','maximum','sum')),
  modality         TEXT CHECK (modality IN ('sensed','self_reported','derived')),
  status           TEXT NOT NULL CHECK (status IN ('final','amended','entered-in-error')),
  device_id        TEXT REFERENCES consent_device(device_id),
  activity_id      TEXT REFERENCES core_activity(activity_id),
  CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_observation_subject_party ON core_observation(subject_party_id);
CREATE INDEX IF NOT EXISTS idx_observation_device ON core_observation(device_id);
CREATE INDEX IF NOT EXISTS idx_observation_activity ON core_observation(activity_id);

CREATE TABLE core_observation_component (
  component_id   TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES core_observation(observation_id),
  code           TEXT NOT NULL,
  value_num      REAL NOT NULL,
  unit           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_observation_component_observation ON core_observation_component(observation_id);

CREATE TABLE core_link (
  link_id             TEXT PRIMARY KEY,
  from_type           TEXT NOT NULL,
  from_id             TEXT NOT NULL,
  to_type             TEXT NOT NULL,
  to_id               TEXT NOT NULL,
  relation_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id),
  valid_from          TEXT NOT NULL,
  valid_to            TEXT,
  asserted_by         TEXT NOT NULL CHECK (asserted_by IN ('owner','app','agent','import')),
  provenance_id       TEXT -- → consent.provenance (journal.db); gateway-enforced
) STRICT;
CREATE INDEX IF NOT EXISTS idx_link_relation_concept ON core_link(relation_concept_id);

CREATE TABLE core_concept_scheme (
  scheme_id TEXT PRIMARY KEY,
  uri       TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL,
  publisher TEXT,
  version   TEXT NOT NULL
) STRICT;

CREATE TABLE core_concept (
  concept_id         TEXT PRIMARY KEY,
  scheme_id          TEXT NOT NULL REFERENCES core_concept_scheme(scheme_id),
  notation           TEXT NOT NULL,
  pref_label         TEXT NOT NULL,
  alt_labels_json    TEXT CHECK (alt_labels_json IS NULL OR json_valid(alt_labels_json)),
  broader_concept_id TEXT REFERENCES core_concept(concept_id),
  definition         TEXT,
  UNIQUE (scheme_id, notation)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_concept_broader_concept ON core_concept(broader_concept_id);

CREATE TABLE core_tag (
  tag_id             TEXT PRIMARY KEY,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  concept_id         TEXT NOT NULL REFERENCES core_concept(concept_id),
  tagged_by_party_id TEXT REFERENCES core_party(party_id),
  confidence         REAL CHECK (confidence BETWEEN 0 AND 1),
  tagged_at          TEXT NOT NULL,
  UNIQUE (target_type, target_id, concept_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tag_concept ON core_tag(concept_id);
CREATE INDEX IF NOT EXISTS idx_tag_tagged_by_party ON core_tag(tagged_by_party_id);

-- One curation mechanism (issue #274): an owner-curated, ordered, typed
-- container. Albums and notebooks are surface views over this one table —
-- "Paris trip" may hold photos, the lease PDF and a packing note together.
-- Audiences (social.circle) and classification (folders-scheme tags) pass
-- the same test and deliberately stay separate mechanisms.
CREATE TABLE core_collection (
  collection_id        TEXT PRIMARY KEY,
  owner_party_id       TEXT NOT NULL REFERENCES core_party(party_id),
  name                 TEXT NOT NULL,
  cover_content_id     TEXT REFERENCES core_content_item(content_id),
  parent_collection_id TEXT REFERENCES core_collection(collection_id),
  sort_order           INTEGER NOT NULL,
  created_at           TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_collection_owner_party ON core_collection(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_collection_cover_content ON core_collection(cover_content_id);
CREATE INDEX IF NOT EXISTS idx_collection_parent_collection ON core_collection(parent_collection_id);

CREATE TABLE core_collection_entry (
  entry_id      TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES core_collection(collection_id),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  position      INTEGER NOT NULL,
  added_at      TEXT NOT NULL,
  UNIQUE (collection_id, target_type, target_id)
) STRICT;
`;

// Standoff anchor for inline references (issue #282). An anchor is a LOCATOR
// for an existing core.link judgment, not a second judgment (rule 10): it
// points into the from-endpoint's plain body text with a W3C-style selector
// {exact, prefix, suffix, start} so the read view can render the edge as an
// inline chip. Bodies stay canonical deduped bytes — the anchor lives outside
// them. One anchor per link (an inline mention IS one edge); no independent
// lifecycle: resolution only considers live links, so anchors of ended links
// are simply never resolved, and the dangling-link sweep needs no extension.
// Ships as its own migration step — CORE_DDL is v1 and already applied.
// IF NOT EXISTS keeps the step re-runnable (the v3 test rewinds and replays
// the ladder), matching v3's guarded-insert style.
export const LINK_ANCHOR_DDL = `
CREATE TABLE IF NOT EXISTS core_link_anchor (
  anchor_id     TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL UNIQUE REFERENCES core_link(link_id),
  selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
  created_at    TEXT NOT NULL
) STRICT;
`;
