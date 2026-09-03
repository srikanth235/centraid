import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const CORE_DDL = `
CREATE TABLE core_vault (
  vault_id        TEXT PRIMARY KEY,
  -- The vault's OWN party — the person as DATA (#916, ruling ONT-05). It
  -- confers nothing; see the header.
  self_party_id   TEXT REFERENCES core_party(party_id),
  display_name    TEXT NOT NULL,
  -- No 'exported' (#916, ONT-07): nothing ever set it, and a vault that has
  -- been exported is still active — an export is a copy, not a state change.
  status          TEXT NOT NULL CHECK (status IN ('active','locked')),
  base_currency   TEXT NOT NULL CHECK (length(base_currency) = 3),
  settings_json   TEXT NOT NULL CHECK (json_valid(settings_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (vault_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_vault_self_party ON core_vault(self_party_id);

CREATE TABLE core_party (
  party_id          TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('person','org','group','agent','animal')),
  display_name      TEXT NOT NULL,
  sort_name         TEXT,
  birth_date        TEXT,
  avatar_content_id TEXT REFERENCES core_content_item(content_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- No \`ontology_version\` (#916, ruling ONT-04): the ontology version is a
  -- property of the FILE (\`PRAGMA user_version\`) and of the CONTRACT
  -- (\`agent_command.ontology_version\`), never of a row.
  -- THE TRASH PAIR (#916, owner decision D1). A person the member no longer
  -- keeps was previously undeletable: \`erasePurgedPerson\` walked foreign keys
  -- by nullability and deleted whatever it could reach, which destroyed OTHER
  -- people's expense splits and wrote no provenance. A party is now trashed
  -- and then PURGED like every other kind — the purge is one hard DELETE, the
  -- supertype cascade takes the pointers with it, and every REMAINING foreign
  -- key onto \`core_party\` is what refuses the purge while the person is still
  -- referenced. See \`entity-catalog.ts\` for the per-column audit of which of
  -- those keys were relaxed to ON DELETE SET NULL and which hold the line.
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (party_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_party_avatar_content ON core_party(avatar_content_id);
CREATE INDEX IF NOT EXISTS core_party_purge_idx
  ON core_party(purge_at) WHERE purge_at IS NOT NULL;

CREATE TABLE core_party_identifier (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  -- No 'email'/'tel' (#883, ruling O-contact): an address you can REACH a
  -- person at is a \`social.contact_channel\`, not an identity register entry.
  scheme        TEXT NOT NULL CHECK (scheme IN ('url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (identifier_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
  -- No UNIQUE (scheme, value) (#916, R3 / review 2.3). The constraint covered
  -- HISTORICAL rows too, so an address one person stopped using could never be
  -- recorded for the person who now holds it — and identity merge could not
  -- move an identifier without first end-dating and deleting it. Uniqueness is
  -- a claim about what is TRUE NOW, so it is a partial index over the live
  -- rows and nothing else.
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS core_party_identifier_live_idx
  ON core_party_identifier(scheme, value) WHERE valid_to IS NULL;
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
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (place_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_place_parent_place ON core_place(parent_place_id);
-- #916, R12 / review 10.3: \`findOrCreatePlaceTx\` looks a place up by rounded
-- coordinate on every photo import and had no index to do it with.
CREATE INDEX IF NOT EXISTS core_place_coords_idx ON core_place(geo_lat, geo_lng);

CREATE TABLE core_event (
  event_id           TEXT PRIMARY KEY,
  ical_uid           TEXT UNIQUE,
  summary            TEXT NOT NULL,
  description        TEXT,
  dtstart            TEXT NOT NULL,
  dtend              TEXT CHECK (dtend IS NULL OR dtend >= dtstart),
  start_tz           TEXT,
  end_tz             TEXT,
  -- Moved here from TIME_ORGANIZE_DDL's ALTER (#916): the two CHECKs below
  -- read it, and a table-level CHECK cannot name a column a later statement
  -- adds. Two zones are real — an event may start in one and end in another —
  -- so \`core_event\` keeps a PAIR while every other table settled on \`tz\`
  -- (#916, R4).
  recurrence_semantics TEXT NOT NULL DEFAULT 'zoned'
    CHECK (recurrence_semantics IN ('zoned','floating','all-day')),
  rrule              TEXT,
  status             TEXT NOT NULL CHECK (status IN ('confirmed','tentative','cancelled')),
  location_place_id  TEXT REFERENCES core_place(place_id),
  -- ATTRIBUTION, not authority: who convened the event. The event survives the
  -- organizer's purge unattributed rather than blocking it (#916, D1).
  organizer_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  sequence           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- WHAT dtstart MEANS SWITCHES ON recurrence_semantics (#916, R2 / review
  -- 3.3), and until now nothing said so in the file. 'zoned' means dtstart is
  -- a real INSTANT expanded in start_tz, so both halves must be there: a zone
  -- to expand in, and a UTC-suffixed timestamp to expand from. 'floating' and
  -- 'all-day' mean a wall clock with no zone, and neither is required.
  deleted_at         TEXT,
  purge_at           TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (recurrence_semantics <> 'zoned' OR start_tz IS NOT NULL),
  CHECK (recurrence_semantics <> 'zoned' OR substr(dtstart, -1) = 'Z'),
  FOREIGN KEY (event_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_event_location_place ON core_event(location_place_id);
CREATE INDEX IF NOT EXISTS idx_event_organizer_party ON core_event(organizer_party_id);
-- #916, R12 / review 10.3: the daily brief reads every event by date range.
CREATE INDEX IF NOT EXISTS core_event_dtstart_idx ON core_event(dtstart);
CREATE INDEX IF NOT EXISTS idx_event_purge_at ON core_event(purge_at);

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
  closed_at            TEXT,
  FOREIGN KEY (account_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_account_owner_party ON core_account(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_account_institution_party ON core_account(institution_party_id);

CREATE TABLE core_transaction (
  txn_id                TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES core_account(account_id),
  posted_at             TEXT NOT NULL,
  -- A magnitude, never a signed number (#916, R2 / review 10.2): \`direction\`
  -- is the sign, and a negative debit meant two contradicting answers.
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  direction             TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  status                TEXT NOT NULL CHECK (status IN ('pending','posted','void')),
  transfer_group_id     TEXT,
  counterparty_party_id TEXT REFERENCES core_party(party_id),
  description           TEXT,
  category_concept_id   TEXT REFERENCES core_concept(concept_id),
  -- GLOBAL uniqueness, deliberately (#916, R2 / review 2.3). The right key is
  -- (connection_id, external_id) — two connectors may legitimately mint the
  -- same provider id — but \`core_transaction\` carries no connection column:
  -- the connector that imported a row is recorded in \`sync_external_entity\`,
  -- not on the row. Narrowing the key would mean adding a column no writer
  -- fills, so the key stays global until a transaction knows its connection.
  external_id           TEXT UNIQUE,
  created_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (txn_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
  creator_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  origin_device_id TEXT REFERENCES access_device(device_id),
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (content_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_content_item_creator_party ON core_content_item(creator_party_id);
CREATE INDEX IF NOT EXISTS idx_content_item_origin_device ON core_content_item(origin_device_id);
CREATE INDEX IF NOT EXISTS core_content_item_purge_idx
  ON core_content_item(purge_at) WHERE purge_at IS NOT NULL;

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
  updated_at          TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  deleted_at          TEXT,
  purge_at            TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (document_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_document_current_content ON core_document(current_content_id);
CREATE INDEX IF NOT EXISTS core_document_purge_idx
  ON core_document(purge_at) WHERE purge_at IS NOT NULL;

CREATE TABLE core_attachment (
  attachment_id TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  content_id    TEXT NOT NULL REFERENCES core_content_item(content_id),
  role          TEXT NOT NULL CHECK (role IN ('photo','manual','receipt','warranty','contract','embed','other')),
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  created_at    TEXT NOT NULL,
  FOREIGN KEY (attachment_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attachment_content ON core_attachment(content_id);
CREATE INDEX IF NOT EXISTS idx_attachment_target ON core_attachment(target_type, target_id);

CREATE TABLE core_activity (
  activity_id       TEXT PRIMARY KEY,
  actor_party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  kind_concept_id   TEXT NOT NULL REFERENCES core_concept(concept_id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT CHECK (ended_at IS NULL OR ended_at >= started_at),
  location_place_id TEXT REFERENCES core_place(place_id),
  source_app_id     TEXT REFERENCES access_app(app_id),
  created_at        TEXT NOT NULL,
  FOREIGN KEY (activity_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_actor_party ON core_activity(actor_party_id);
CREATE INDEX IF NOT EXISTS idx_activity_kind_concept ON core_activity(kind_concept_id);
CREATE INDEX IF NOT EXISTS idx_activity_location_place ON core_activity(location_place_id);
CREATE INDEX IF NOT EXISTS idx_activity_source_app ON core_activity(source_app_id);

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
  -- → access.provenance, in the append-only audit band. A VALUE, not a key:
  -- the audit outlives its subject (#916).
  provenance_id       TEXT,
  updated_at          TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (link_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (from_type, from_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE,
  FOREIGN KEY (to_type, to_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
-- ONE LIVE EDGE per (from, to, relation) (#916, R2 / review 10.2). Nothing
-- stopped the same relation being asserted twice between the same two rows, so
-- a re-import or a double tap drew a second edge that every reader then
-- counted, and \`core.merge_party\` could fold two parties into one and leave
-- the survivor holding two identical links. Partial on the LIVE rows: an
-- end-dated edge is history, and history repeats.
CREATE UNIQUE INDEX IF NOT EXISTS core_link_live_edge_idx
  ON core_link(from_type, from_id, to_type, to_id, relation_concept_id)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_link_relation_concept ON core_link(relation_concept_id);
CREATE INDEX IF NOT EXISTS idx_link_from ON core_link(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_link_to ON core_link(to_type, to_id);

CREATE TABLE core_concept_scheme (
  scheme_id TEXT PRIMARY KEY,
  uri       TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL,
  publisher TEXT,
  version   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (scheme_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE core_concept (
  concept_id         TEXT PRIMARY KEY,
  scheme_id          TEXT NOT NULL REFERENCES core_concept_scheme(scheme_id),
  notation           TEXT NOT NULL,
  pref_label         TEXT NOT NULL,
  alt_labels_json    TEXT CHECK (alt_labels_json IS NULL OR json_valid(alt_labels_json)),
  broader_concept_id TEXT REFERENCES core_concept(concept_id),
  definition         TEXT,
  created_at         TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at         TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (scheme_id, notation),
  FOREIGN KEY (concept_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_concept_broader_concept ON core_concept(broader_concept_id);

CREATE TABLE core_tag (
  tag_id             TEXT PRIMARY KEY,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  concept_id         TEXT NOT NULL REFERENCES core_concept(concept_id),
  tagged_by_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  confidence         REAL CHECK (confidence BETWEEN 0 AND 1),
  tagged_at          TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (target_type, target_id, concept_id),
  FOREIGN KEY (tag_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
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
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (collection_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
  UNIQUE (collection_id, target_type, target_id),
  FOREIGN KEY (entry_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
-- Membership is asked target-first ("which collections hold this photo?") as
-- often as collection-first (#883).
CREATE INDEX IF NOT EXISTS idx_collection_entry_target
  ON core_collection_entry(target_type, target_id);

${touchUpdatedAt("core_vault", "vault_id")}
${touchUpdatedAt("core_party", "party_id")}
${touchUpdatedAt("core_party_identifier", "identifier_id")}
${touchUpdatedAt("core_place", "place_id")}
${touchUpdatedAt("core_event", "event_id")}
${touchUpdatedAt("core_transaction", "txn_id")}
${touchUpdatedAt("core_content_item", "content_id")}
${touchUpdatedAt("core_document", "document_id")}
${touchUpdatedAt("core_link", "link_id")}
${touchUpdatedAt("core_concept", "concept_id")}
${touchUpdatedAt("core_tag", "tag_id")}
${touchUpdatedAt("core_collection", "collection_id")}
`;

export const LINK_ANCHOR_DDL = `
CREATE TABLE core_link_anchor (
  anchor_id     TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL UNIQUE REFERENCES core_link(link_id),
  selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (anchor_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
${touchUpdatedAt("core_link_anchor", "anchor_id")}
`;

export const SHARE_ORIGIN_DDL = `
CREATE TABLE core_share_origin (
  -- \`target_*\`, the one name a polymorphic pair has in this vault (#916).
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  origin_vault_id  TEXT NOT NULL,
  origin_item_id   TEXT NOT NULL,
  shared_by        TEXT NOT NULL,
  shared_at        INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_share_origin_vault ON core_share_origin(origin_vault_id);
${touchUpdatedAt("core_share_origin", ["target_type", "target_id"])}
`;
