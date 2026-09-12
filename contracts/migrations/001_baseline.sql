-- GENERATED — do not edit. Rung one of the v1 ladder: the baseline schema.
--
--   cargo run -p centraid-vault --bin export-baseline -- \
--     contracts/golden/issue-1020/vault.db.gz > contracts/migrations/001_baseline.sql
--
-- Ordered by DEPENDENCY (tables, views, indexes, triggers), not by name, so it
-- is runnable; `contracts/schema/vault-ddl.sql` is the same shape ordered for
-- READING and is not. FTS shadow tables, `sqlite_sequence` and
-- `sqlite_autoindex_*` are omitted: SQLite creates each of them itself and
-- refuses the hand-written DDL. `crates/vault/tests/baseline.rs` founds a
-- vault from this file and diffs its schema against the corpus (#1020).
--
-- THIS FILE IS BOTH the migration `crates/vault` embeds and the fixture under
-- `contracts/` (D-1020-D1-13): one file, because two copies of a schema is two
-- answers to one question.

---- tables (157)

-- table access_agent
CREATE TABLE access_agent (
  agent_id       TEXT PRIMARY KEY,
  party_id       TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  model_ref       TEXT NOT NULL,
  version         TEXT NOT NULL,
  enrolled_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('active','paused','revoked'))
) STRICT;

-- table access_agent_secret
CREATE TABLE access_agent_secret (
  agent_id       TEXT PRIMARY KEY REFERENCES access_agent(agent_id) ON DELETE CASCADE,
  enrollment_key TEXT NOT NULL UNIQUE
) STRICT;

-- table access_app
CREATE TABLE access_app (
  app_id       TEXT PRIMARY KEY,
  -- The host-side enrollment key (Centraid app id) — lookup identity,
  -- never shown to the owner directly. display_name (nullable, falls
  -- back to a humanized name — see host.ts) is what an approval surface
  -- renders (issue: parked-invocation trust legibility).
  name         TEXT NOT NULL,
  display_name TEXT,
  -- The owner's per-vault rename (issue #434). Distinct from display_name:
  -- display_name self-heals to the app manifest/pretty name on every
  -- re-enrollment, so it cannot hold a durable override. label is never
  -- touched by the self-heal — the app listing prefers it over the manifest
  -- name. NULL means no override (fall back to the manifest name). Bundled
  -- app code is read-only, so a rename cannot rewrite app.json; it lands here.
  label        TEXT,
  publisher    TEXT,
  manifest_uri TEXT,
  signing_key  TEXT UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('active','revoked')),
  -- One value, because an app reaches a vault by being installed and has had
  -- no other door since #799 (#916, ruling ONT-07).
  origin       TEXT NOT NULL CHECK (origin IN ('installed')),
  risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low','medium','high')),
  installed_at TEXT NOT NULL,
  -- WHEN THE INSTALL ENDED (#928). An app is not a principal, so there is no
  -- grant whose `revoked_at` an app could be told about; the register itself
  -- records it, and that timestamp is what the bridge hands back so an app
  -- can say "you removed my access on <date>" rather than guessing.
  revoked_at   TEXT,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;

-- table access_app_ext
CREATE TABLE access_app_ext (
  app_id      TEXT NOT NULL,
  band        TEXT NOT NULL DEFAULT 'live' CHECK (band IN ('live', 'draft')),
  table_name  TEXT NOT NULL,
  physical    TEXT NOT NULL UNIQUE,
  spec_json   TEXT NOT NULL CHECK (json_valid(spec_json)),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retained')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (app_id, band, table_name)
) STRICT;

-- table access_device
CREATE TABLE access_device (
  device_id      TEXT PRIMARY KEY,
  -- Identity here, authority next door: this says who the device IS;
  -- `share_authority` says what the member let it do (#883).
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  platform       TEXT,
  enrolled_at    TEXT NOT NULL,
  last_seen_at   TEXT
) STRICT;

-- table access_device_secret
CREATE TABLE access_device_secret (
  device_id      TEXT PRIMARY KEY REFERENCES access_device(device_id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL UNIQUE,
  -- How far the gateway has served THIS device. Gateway bookkeeping about a
  -- seat, never a fact the seat's own copy should carry.
  sync_cursor    TEXT
, sync_cursor_at TEXT) STRICT;

-- table access_provenance
CREATE TABLE access_provenance (
  prov_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_activity TEXT NOT NULL,
  agent_kind    TEXT NOT NULL CHECK (agent_kind IN ('owner','app','ai_agent','import')),
  agent_id      TEXT NOT NULL,
  used_json     TEXT CHECK (used_json IS NULL OR json_valid(used_json)),
  occurred_at   TEXT NOT NULL,
  prev_prov_id  TEXT REFERENCES access_provenance(prov_id),
  signature     TEXT
) STRICT;

-- table access_receipt
CREATE TABLE access_receipt (
  receipt_id         TEXT PRIMARY KEY,
  -- ONE ID SPACE (#928, AP-one-id-space). The receipt used to name four:
  -- an app grant, an agent grant, a commons grant and a share authority, all
  -- in one nullable `grant_id`, so "which plane answered" was a guess made
  -- by whoever read it. Every answer is a `share_authority` row now, and
  -- NULL means owner-direct — the one act that needs no answer.
  authority_id       TEXT, -- → share.authority; NULL for owner-direct
  invocation_id      TEXT REFERENCES agent_command_invocation(invocation_id),
  action             TEXT NOT NULL,
  object_type        TEXT NOT NULL,
  object_id          TEXT,
  decision           TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  occurred_at        TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  -- CHAIN ORDER, SAID OUT LOUD (#916, R13 / review 5.4). The hash chain's head
  -- was found with `ORDER BY receipt_id DESC`, which is correct only because
  -- receipt ids happen to be UUIDv7 and therefore happen to sort by time — an
  -- accident of the id scheme holding up the integrity of the chain. `seq` is
  -- the chain position itself: monotonic per file, assigned when the receipt
  -- is written. Nullable, because an evidence stream is never rewritten and
  -- rows written before it existed have none; a reader falls back to id order
  -- while it is NULL.
  seq                INTEGER
) STRICT;

-- table access_seed_row
CREATE TABLE access_seed_row (
  seed_id     TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  seeded_at   TEXT NOT NULL,
  UNIQUE (target_type, target_id)
) STRICT;

-- table agent_capability
CREATE TABLE agent_capability (
  capability_id         TEXT PRIMARY KEY,
  schema_name           TEXT NOT NULL,
  verb                  TEXT NOT NULL CHECK (verb IN ('discover','query','reason','act','verify','explain')),
  command_id            TEXT REFERENCES agent_command(command_id),
  description           TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL CHECK (requires_confirmation IN (0,1))
) STRICT;

-- table agent_command
CREATE TABLE agent_command (
  command_id          TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  owner_schema        TEXT NOT NULL,
  input_schema_json   TEXT NOT NULL CHECK (json_valid(input_schema_json)),
  output_schema_json  TEXT NOT NULL CHECK (json_valid(output_schema_json)),
  preconditions_json  TEXT NOT NULL CHECK (json_valid(preconditions_json)),
  postconditions_json TEXT NOT NULL CHECK (json_valid(postconditions_json)),
  idempotency         TEXT NOT NULL CHECK (idempotency IN ('idempotent','once','retry-safe')),
  risk                TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  ontology_version    TEXT NOT NULL
) STRICT;

-- table agent_command_invocation
CREATE TABLE agent_command_invocation (
  invocation_id TEXT PRIMARY KEY,
  -- Pointers into the MODEL half stay VALUE columns, not keys: an audit row
  -- outlives its subject by design, and a foreign key would either block the
  -- member's purge or quietly rewrite the evidence (#916).
  command_id    TEXT NOT NULL, -- → agent.command
  caller_id     TEXT NOT NULL, -- → access.agent / access.device
  authority_id  TEXT,          -- → share.authority; NULL for owner-direct
  input_json    TEXT NOT NULL CHECK (json_valid(input_json)),
  status        TEXT NOT NULL CHECK (status IN ('proposed','checked','executed','failed','rolled_back')),
  requested_at  TEXT NOT NULL,
  executed_at   TEXT,
  receipt_id    TEXT REFERENCES access_receipt(receipt_id)
) STRICT;

-- table agent_evidence
CREATE TABLE agent_evidence (
  evidence_id   TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  claim         TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  prov_id       TEXT REFERENCES access_provenance(prov_id),
  weight        REAL CHECK (weight BETWEEN 0 AND 1)
) STRICT;

-- table agent_explanation
CREATE TABLE agent_explanation (
  explanation_id TEXT PRIMARY KEY,
  invocation_id  TEXT NOT NULL UNIQUE REFERENCES agent_command_invocation(invocation_id),
  audience       TEXT NOT NULL CHECK (audience IN ('owner','auditor')),
  summary        TEXT NOT NULL,
  generated_at   TEXT NOT NULL
) STRICT;

-- table agent_invocation_check
CREATE TABLE agent_invocation_check (
  check_id      TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_command_invocation(invocation_id),
  phase         TEXT NOT NULL CHECK (phase IN ('pre','post')),
  predicate     TEXT NOT NULL,
  passed        INTEGER NOT NULL CHECK (passed IN (0,1)),
  observed_json TEXT CHECK (observed_json IS NULL OR json_valid(observed_json)),
  checked_at    TEXT NOT NULL
) STRICT;

-- table attachments
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  source     TEXT,
  filename   TEXT,
  -- Harness-created files stay in their workspace. The hash verifies the
  -- referenced bytes; no duplicate is copied into the blob CAS.
  workspace_path TEXT,
  created_at INTEGER NOT NULL
) STRICT;

-- table audit_archive_manifest
CREATE TABLE audit_archive_manifest (
  manifest_id      TEXT PRIMARY KEY,
  -- 'provenance' (access_provenance) or 'invocation_cluster' (the mutually
  -- FK-linked agent_command_invocation + access_receipt +
  -- agent_invocation_check + agent_evidence + agent_explanation rows for a
  -- batch of invocations old enough, receipt included, to seal together —
  -- see journal-archive.ts for why these archive as one unit).
  stream           TEXT NOT NULL CHECK (stream IN ('provenance', 'invocation_cluster')),
  from_id          TEXT,
  to_id            TEXT,
  from_time        TEXT NOT NULL,
  to_time          TEXT NOT NULL,
  row_count        INTEGER NOT NULL CHECK (row_count > 0),
  segment_sha256   TEXT NOT NULL CHECK (length(segment_sha256) = 64),
  segment_bytes    INTEGER NOT NULL CHECK (segment_bytes >= 0),
  prev_manifest_id TEXT REFERENCES audit_archive_manifest(manifest_id),
  chain_hash       TEXT NOT NULL,
  created_at       TEXT NOT NULL
) STRICT;

-- table audit_archive_pass
CREATE TABLE audit_archive_pass (
  active INTEGER PRIMARY KEY CHECK (active = 1)
) STRICT;

-- table automation_state
CREATE TABLE automation_state (
  automation_id TEXT NOT NULL,
  key           TEXT NOT NULL,
  value_json    TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, key)
) STRICT;

-- table automation_trigger_cursor
CREATE TABLE automation_trigger_cursor (
  automation_id TEXT NOT NULL,
  trigger_index INTEGER NOT NULL,
  source_kind   TEXT NOT NULL,
  position_json TEXT,
  pending_json  TEXT,
  window_from  INTEGER,
  window_to    INTEGER,
  skipped      INTEGER NOT NULL DEFAULT 0,
  gap_reason   TEXT,
  updated_at   INTEGER NOT NULL, dead_letter_json TEXT,
  PRIMARY KEY (automation_id, trigger_index)
) STRICT;

-- table blob_access
CREATE TABLE blob_access (
  sha256         TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  last_access_at TEXT NOT NULL,
  byte_size      INTEGER
) STRICT;

-- table blob_content_key
CREATE TABLE blob_content_key (
  sha256       TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  wrapped_key  BLOB NOT NULL,
  wrap_nonce   BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  key_epoch    INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table blob_custody_rollup
CREATE TABLE blob_custody_rollup (
  bucket      TEXT PRIMARY KEY,
  item_count  INTEGER NOT NULL CHECK (item_count >= 0),
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  computed_at TEXT NOT NULL
) STRICT;

-- table blob_custody_state
CREATE TABLE blob_custody_state (
  content_id    TEXT PRIMARY KEY REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
  custody_state TEXT NOT NULL CHECK (custody_state IN ('pending-offsite','local-only','replicated','remote-only','missing')),
  checked_at    TEXT NOT NULL
) STRICT;

-- table blob_device_content_key
CREATE TABLE blob_device_content_key (
  sha256       TEXT NOT NULL REFERENCES blob_content_key(sha256) ON DELETE CASCADE,
  device_id    TEXT NOT NULL REFERENCES access_device(device_id) ON DELETE CASCADE,
  wrapped_key  BLOB NOT NULL,
  wrap_nonce   BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  device_key_epoch INTEGER NOT NULL CHECK (device_key_epoch > 0),
  granted_at   TEXT NOT NULL,
  PRIMARY KEY (sha256, device_id)
) STRICT;

-- table blob_device_wrap_key
CREATE TABLE blob_device_wrap_key (
  device_id    TEXT PRIMARY KEY REFERENCES access_device(device_id) ON DELETE CASCADE,
  key_epoch    INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
  salt         BLOB NOT NULL CHECK (length(salt) = 32),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table blob_ingress_probe
CREATE TABLE blob_ingress_probe (
  session_id  TEXT PRIMARY KEY REFERENCES blob_ingress_session(session_id) ON DELETE CASCADE,
  head_bytes  BLOB,
  tail_bytes  BLOB
) STRICT;

-- table blob_ingress_session
CREATE TABLE blob_ingress_session (
  session_id       TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('fallback','stream-through','direct')),
  state            TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','committing','complete','aborted')),
  expected_sha256  TEXT CHECK (expected_sha256 IS NULL OR length(expected_sha256) = 64),
  expected_size    INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
  received_bytes   INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  hash_state_json  TEXT CHECK (hash_state_json IS NULL OR json_valid(hash_state_json)),
  temp_path        TEXT,
  remote_temp_id   TEXT,
  remote_upload_id TEXT,
  remote_parts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(remote_parts_json)),
  media_type       TEXT,
  original_name    TEXT,
  meta_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  staged_by        TEXT,
  sealed_size      INTEGER CHECK (sealed_size IS NULL OR sealed_size >= 0),
  part_count       INTEGER CHECK (part_count IS NULL OR (part_count > 0 AND part_count <= 10000)),
  device_id        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  expires_at       TEXT NOT NULL
) STRICT;

-- table blob_orphan
CREATE TABLE blob_orphan (
  sha256            TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  first_orphaned_at INTEGER NOT NULL CHECK (first_orphaned_at >= 0)
) STRICT;

-- table blob_outbox
CREATE TABLE blob_outbox (
  sha256          TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size       INTEGER NOT NULL CHECK (byte_size >= 0),
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading')),
  temp_id         TEXT,
  upload_id       TEXT,
  parts_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parts_json)),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- THE CONFLICT COMPARATOR (#996, R6). Bumped by this table's
  -- touch trigger on every update, so an intent's expected version is
  -- compared against a COLUMN rather than against a log position.
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
, quarantined_at TEXT) STRICT;

-- table blob_replica
CREATE TABLE blob_replica (
  sha256        TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  replicated_at TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  store         TEXT NOT NULL DEFAULT 'cas' CHECK (store IN ('cas','derived'))
) STRICT;

-- table blob_staging
CREATE TABLE blob_staging (
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
  staged_at     TEXT NOT NULL, held_by_intent TEXT,
  CHECK (variant IS NULL OR
    (variant IN ('thumb','preview','poster') AND inline_content IS NULL) OR
    (variant IN ('text','transcript','embedding','phash','thumbhash') AND inline_content IS NOT NULL))
) STRICT;

-- table conversation_archive
CREATE TABLE conversation_archive (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq_from               INTEGER NOT NULL,
  seq_to                 INTEGER NOT NULL,
  from_time              INTEGER NOT NULL,
  to_time                INTEGER NOT NULL,
  turn_count             INTEGER NOT NULL,
  item_count             INTEGER NOT NULL,
  segment_sha256         TEXT NOT NULL CHECK (length(segment_sha256) = 64),
  segment_bytes          INTEGER NOT NULL CHECK (segment_bytes >= 0),
  plaintext_bytes        INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  attachment_hashes_json TEXT NOT NULL DEFAULT '[]',
  pruned_at              INTEGER,
  created_at             INTEGER NOT NULL
) STRICT;

-- table conversation_digest
CREATE TABLE conversation_digest (
  conversation_id          TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL,
  app_id                   TEXT,
  automation_ref           TEXT,
  automation_name          TEXT,
  title                    TEXT NOT NULL DEFAULT '',
  first_started_at         INTEGER,
  last_ended_at            INTEGER,
  run_count                INTEGER NOT NULL DEFAULT 0,
  ok_count                 INTEGER NOT NULL DEFAULT 0,
  err_count                INTEGER NOT NULL DEFAULT 0,
  retry_count              INTEGER NOT NULL DEFAULT 0,
  total_input_tokens       INTEGER NOT NULL DEFAULT 0,
  total_output_tokens      INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_hydration_tokens   INTEGER NOT NULL DEFAULT 0,
  total_cost_usd           REAL NOT NULL DEFAULT 0,
  step_count               INTEGER NOT NULL DEFAULT 0,
  tool_count               INTEGER NOT NULL DEFAULT 0,
  models_json              TEXT NOT NULL DEFAULT '[]',
  efforts_json             TEXT NOT NULL DEFAULT '[]',
  updated_at               INTEGER NOT NULL
) STRICT;

-- table conversation_harness_sessions
CREATE TABLE conversation_harness_sessions (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  harness_kind           TEXT NOT NULL,
  acp_session_id        TEXT NOT NULL,
  usage_snapshot_json   TEXT,
  hydrated_through_seq  INTEGER NOT NULL DEFAULT -1,
  status                TEXT NOT NULL DEFAULT 'warm',
  last_used_at          INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  UNIQUE (conversation_id, harness_kind, acp_session_id),
  CHECK (status IN ('active','warm','cold','stale'))
) STRICT;

-- table conversation_provider_consent
CREATE TABLE conversation_provider_consent (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  harness_kind     TEXT NOT NULL,
  source          TEXT NOT NULL,
  subsystem       TEXT NOT NULL,
  granted_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  PRIMARY KEY (conversation_id, harness_kind, source, subsystem),
  CHECK (
    (source = 'direct' AND subsystem = '')
    OR
    (source = 'ladder' AND subsystem IN ('assistant','ask','builder','automations'))
  )
) STRICT;

-- table conversation_turn_locks
CREATE TABLE conversation_turn_locks (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  lock_token      TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL
) STRICT;

-- table conversation_workspace_selection
CREATE TABLE conversation_workspace_selection (
  conversation_id             TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  primary_kind                TEXT NOT NULL,
  additional_directories_json TEXT NOT NULL DEFAULT '[]',
  updated_at                  INTEGER NOT NULL,
  CHECK (primary_kind IN ('vault-data','app','draft'))
) STRICT;

-- table conversations
CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  app_id             TEXT,
  automation_id      TEXT,
  title              TEXT NOT NULL DEFAULT '',
  harness_kind       TEXT,
  harness_session_id TEXT,
  harness_usage_json TEXT,
  hydration_count    INTEGER NOT NULL DEFAULT 0,
  last_hydrated_at   INTEGER,
  turn_count         INTEGER NOT NULL DEFAULT 0,
  item_count         INTEGER NOT NULL DEFAULT 0,
  pinned             INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (kind IN ('chat','automation','build'))
) STRICT;

-- table core_account
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

-- table core_activity
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

-- table core_attachment
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

-- table core_collection
CREATE TABLE core_collection (
  collection_id        TEXT PRIMARY KEY,
  owner_party_id       TEXT NOT NULL REFERENCES core_party(party_id),
  name                 TEXT NOT NULL,
  cover_content_id     TEXT REFERENCES core_content_item(content_id),
  parent_collection_id TEXT REFERENCES core_collection(collection_id),
  sort_order           INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (collection_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_collection_entry
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

-- table core_concept
CREATE TABLE core_concept (
  concept_id         TEXT PRIMARY KEY,
  scheme_id          TEXT NOT NULL REFERENCES core_concept_scheme(scheme_id),
  notation           TEXT NOT NULL,
  pref_label         TEXT NOT NULL,
  alt_labels_json    TEXT CHECK (alt_labels_json IS NULL OR json_valid(alt_labels_json)),
  broader_concept_id TEXT REFERENCES core_concept(concept_id),
  definition         TEXT,
  -- CONCEPT IDENTITY (#996, ruling R20(d)). A concept's LABEL was its identity:
  -- The ASCII slug lowercased a label and stripped everything outside
  -- `[a-z0-9]`, so `猫`, `犬`, `कुत्ता` and `बिल्ली` all normalised to
  -- `untitled` and selected ONE concept — four animals filed as one idea, on
  -- every vault that does not write in Latin script. Three columns separate the
  -- three jobs the notation was doing at once:
  --   `stable_id` — the source vocabulary's OWN concept id where it has one;
  --   `normalized_key` — a UNICODE-PRESERVING key (NFKC, collapsed
  --     whitespace, case-folded) for schemes where only labels exist, which is
  --     what `ensureConcept` selects on;
  --   `pref_label_lang` — the label's language tag, so "the label" is
  --     answerable in the language it was written in.
  -- `notation` goes back to being the 64-character ASCII SLUG it always
  -- looked like, with collision cases given a suffix rather than a shared row.
  stable_id          TEXT,
  normalized_key     TEXT,
  pref_label_lang    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (scheme_id, notation),
  FOREIGN KEY (concept_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_concept_scheme
CREATE TABLE core_concept_scheme (
  scheme_id TEXT PRIMARY KEY,
  uri       TEXT NOT NULL UNIQUE,
  title     TEXT NOT NULL,
  publisher TEXT,
  version   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (scheme_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_content_derivative
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
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (content_id, variant),
  CHECK ((variant IN ('thumb','preview','poster')) = (sha256 IS NOT NULL)),
  CHECK ((variant IN ('text','transcript','embedding','phash','thumbhash')) = (text_content IS NOT NULL)),
  FOREIGN KEY (derivative_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_content_item
CREATE TABLE core_content_item (
  content_id       TEXT PRIMARY KEY,
  content_uri      TEXT NOT NULL,
  -- A HASH IS SIXTY-FOUR HEX CHARACTERS (#996, ruling R21; drift ONT-26).
  -- Nothing held the shape, so a writer could put anything in the column that
  -- IS the dedupe key for every owner of those bytes. The "unchanged bytes"
  -- half is the `core_content_item_hash_follows_bytes` trigger below: a
  -- summary cannot change while what it summarises stays where it is.
  sha256           TEXT NOT NULL UNIQUE
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size        INTEGER NOT NULL CHECK (byte_size >= 0),
  language         TEXT,
  creator_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  origin_device_id TEXT REFERENCES access_device(device_id),
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (content_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_content_representation
CREATE TABLE core_content_representation (
  representation_id TEXT PRIMARY KEY,
  content_id        TEXT NOT NULL
    REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  -- The owner, polymorphic through the supertype: core.document,
  -- knowledge.note, media.asset, core.attachment, social.message — or
  -- core.content_item itself for bytes a connector staged with no wrapper yet.
  owner_type        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  -- RFC 6838. NOT NULL: a representation exists BECAUSE something is being
  -- read as something, and "no interpretation" is the absence of the row.
  media_type        TEXT NOT NULL,
  -- The text encoding this owner reads the bytes in (RFC 2978), when the
  -- media type does not already carry it.
  charset           TEXT,
  -- What the owner does with them beyond the type: 'body', 'original',
  -- 'attachment', 'avatar', … NULL where the owner has only one use.
  interpretation    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (owner_type, owner_id),
  FOREIGN KEY (representation_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_type, owner_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table core_content_text
CREATE TABLE core_content_text (
  content_id  TEXT PRIMARY KEY
    REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  -- The decoded text itself. NOT NULL: a row exists because a decode
  -- SUCCEEDED, and "we could not decode these bytes" is the ABSENCE of a row,
  -- never an empty string that reads as an empty document.
  body_text   TEXT NOT NULL,
  -- What produced it, so a decoder change can rebuild exactly the rows it
  -- invalidates rather than the whole table.
  decoder     TEXT NOT NULL,
  -- The bytes this text was decoded FROM. Content is hash-addressed and
  -- immutable, so this is a staleness check against the decoder, not the row.
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table core_document
CREATE TABLE core_document (
  document_id         TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  current_content_id  TEXT NOT NULL REFERENCES core_content_item(content_id),
  -- THE NEWEST REVISION OCCURRENCE (#996, ruling R20(a)). History is the chain
  -- of `core_entity_revision` rows walked from here through
  -- `parent_revision_id`, each naming the content that became current at that
  -- moment. ON DELETE SET NULL: a pointer into history must never be the thing
  -- that wedges a delete.
  current_revision_id TEXT REFERENCES core_entity_revision(revision_id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  deleted_at          TEXT,
  purge_at            TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (document_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_entity
CREATE TABLE core_entity (
  entity_id   TEXT NOT NULL PRIMARY KEY,
  entity_type TEXT NOT NULL REFERENCES core_entity_kind(kind),
  created_at  TEXT NOT NULL,
  UNIQUE (entity_type, entity_id)
) STRICT;

-- table core_entity_kind
CREATE TABLE core_entity_kind (
  kind TEXT NOT NULL PRIMARY KEY
) STRICT;

-- table core_entity_revision
CREATE TABLE core_entity_revision (
  revision_id    TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  operation      TEXT NOT NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  recorded_at    TEXT NOT NULL,
  undo_until     TEXT NOT NULL,
  undone_at      TEXT,
  -- ATTRIBUTION (#916, D1): the actor is who did it, and a snapshot whose
  -- actor was purged is still the snapshot. It yields rather than blocking.
  actor_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  -- The command that caused this revision (#916, D2 / review 5.2). Same file
  -- as the audit band now, so it is a REAL key: SET NULL rather than CASCADE
  -- because the archive pass removes old invocations and a revision outlives
  -- the invocation record of it.
  invocation_id  TEXT
    REFERENCES agent_command_invocation(invocation_id) ON DELETE SET NULL,
  -- THE REVISION OCCURRENCE (#996, ruling R20(a) / #916's ONT-revisions).
  --
  -- This table was ruled "the only history table", and a SECOND history graph
  -- went on living beside it: a content→content `revises` `core_link` written
  -- on every body edit and walked by Docs, Notes, the mobile version list, the
  -- blob door and the purge sweep. Identity was taken from a VALUE — the
  -- content id was the version id — so two documents with identical bytes
  -- shared one history, A→B→A→B could not be expressed, and a revision of one
  -- object could be restored into another.
  --
  -- An OCCURRENCE is a row here whose `operation` is 'revise': it names the
  -- content that became current at that moment and the occurrence before it,
  -- and the wrapper points at the newest. A capture snapshot (every other row)
  -- names no content and is bounded by the entity's declared retention; an
  -- occurrence is a member's authored version and is not (#996, OQ-11).
  --
  -- Both `ON DELETE SET NULL`. `content_id`: a purge is allowed to reclaim the
  -- bytes, and the occurrence survives as the record that there WAS a version
  -- there — the alternative is a foreign key that refuses to let an owner
  -- delete their own document. `parent_revision_id`: a truncated chain is a
  -- legible answer where a dangling one is not.
  content_id     TEXT
    REFERENCES core_content_item(content_id) ON DELETE SET NULL,
  parent_revision_id TEXT
    REFERENCES core_entity_revision(revision_id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (revision_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_event
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
  -- so `core_event` keeps a PAIR while every other table settled on `tz`
  -- (#916, R4).
  recurrence_semantics TEXT NOT NULL DEFAULT 'zoned'
    CHECK (recurrence_semantics IN ('zoned','floating','all-day')),
  rrule              TEXT,
  -- AN UNSUPPORTED RULE IS RETAINED, NOT EXECUTED (#996, ruling R21; drift
  -- ONT-31). A rule outside the expander's subset — `BYSETPOS`, `BYMONTHDAY`,
  -- an hourly frequency, or plain nonsense — used to be stored as if it were
  -- executable and then expanded to nothing, which reads at every surface
  -- exactly like "this event does not repeat". A COMMAND refuses such a rule
  -- outright; an IMPORT keeps the provider's text and says so here, because
  -- discarding what the calendar sent would lose the only record of what the
  -- series actually is.
  rrule_support      TEXT NOT NULL DEFAULT 'supported'
    CHECK (rrule_support IN ('supported','unsupported')),
  status             TEXT NOT NULL CHECK (status IN ('confirmed','tentative','cancelled')),
  location_place_id  TEXT REFERENCES core_place(place_id),
  -- ATTRIBUTION, not authority: who convened the event. The event survives the
  -- organizer's purge unattributed rather than blocking it (#916, D1).
  organizer_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  sequence           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
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

-- table core_link
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
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (link_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (from_type, from_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE,
  FOREIGN KEY (to_type, to_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table core_link_anchor
CREATE TABLE core_link_anchor (
  anchor_id     TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL UNIQUE REFERENCES core_link(link_id),
  selector_json TEXT NOT NULL CHECK (json_valid(selector_json)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (anchor_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_party
CREATE TABLE core_party (
  party_id          TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('person','org','group','agent','animal')),
  display_name      TEXT NOT NULL,
  sort_name         TEXT,
  birth_date        TEXT,
  avatar_content_id TEXT REFERENCES core_content_item(content_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- No `ontology_version` (#916, ruling ONT-04): the ontology version is a
  -- property of the FILE (`PRAGMA user_version`) and of the CONTRACT
  -- (`agent_command.ontology_version`), never of a row.
  -- THE TRASH PAIR (#916, owner decision D1). A person the member no longer
  -- keeps was previously undeletable: `erasePurgedPerson` walked foreign keys
  -- by nullability and deleted whatever it could reach, which destroyed OTHER
  -- people's expense splits and wrote no provenance. A party is now trashed
  -- and then PURGED like every other kind — the purge is one hard DELETE, the
  -- supertype cascade takes the pointers with it, and every REMAINING foreign
  -- key onto `core_party` is what refuses the purge while the person is still
  -- referenced. See `entity-catalog.ts` for the per-column audit of which of
  -- those keys were relaxed to ON DELETE SET NULL and which hold the line.
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (party_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_party_identifier
CREATE TABLE core_party_identifier (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  -- No 'email'/'tel' (#883, ruling O-contact): an address you can REACH a
  -- person at is a `social.contact_channel`, not an identity register entry.
  scheme        TEXT NOT NULL CHECK (scheme IN ('url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  -- THE NAMESPACE THE VALUE IS UNIQUE WITHIN (#996, ruling R20(e)). A short
  -- handle is not globally unique: `@alice` on two services is two people,
  -- and an account number means nothing without the institution that issued
  -- it. NULL means "globally unique by construction" — a DID, an IBAN, a URL —
  -- and the live index below folds NULL to the empty string so those keep the
  -- one namespace they always had.
  issuer        TEXT,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- AN INTERVAL RUNS FORWARD (#996, R20(e)). `valid_to < valid_from` was
  -- representable, and an inverted interval makes every "was this live then"
  -- question unanswerable. Table-level because it names two columns.
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (identifier_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
  -- No UNIQUE (scheme, value) (#916, R3 / review 2.3). The constraint covered
  -- HISTORICAL rows too, so an address one person stopped using could never be
  -- recorded for the person who now holds it — and identity merge could not
  -- move an identifier without first end-dating and deleting it. Uniqueness is
  -- a claim about what is TRUE NOW, so it is a partial index over the live
  -- rows and nothing else.
) STRICT;

-- table core_place
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
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (place_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_tag
CREATE TABLE core_tag (
  tag_id             TEXT PRIMARY KEY,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  concept_id         TEXT NOT NULL REFERENCES core_concept(concept_id),
  tagged_by_party_id TEXT REFERENCES core_party(party_id) ON DELETE SET NULL,
  confidence         REAL CHECK (confidence BETWEEN 0 AND 1),
  -- A MACHINE ASSERTION LINKS TO ITS EVIDENCE (#996, ruling R22). A tag with
  -- no asserting party is a machine's claim, and until now it carried a
  -- confidence and nothing else: no way to ask which model said it, from what
  -- input, or what a second model said instead. `derivation_id` names the
  -- `enrich_derivation` row that produced it — which carries the profile, the
  -- model and the payload — and `input_revision_id` names the revision of the
  -- target the claim was made ABOUT, so a claim about superseded content can
  -- be told from one about what is there now.
  --
  -- ON DELETE SET NULL on both: losing the evidence must never be the thing
  -- that deletes the claim, and a claim whose evidence is gone reads as an
  -- unattributed machine tag, which is what it is.
  derivation_id      TEXT REFERENCES enrich_derivation(derivation_id) ON DELETE SET NULL,
  input_revision_id  TEXT REFERENCES core_entity_revision(revision_id) ON DELETE SET NULL,
  tagged_at          TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Evidence belongs to a MACHINE assertion. An owner does not cite a model.
  CHECK (tagged_by_party_id IS NULL
         OR (derivation_id IS NULL AND input_revision_id IS NULL)),
  FOREIGN KEY (tag_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
  -- NO TABLE-LEVEL `UNIQUE (target_type, target_id, concept_id)` (#996, R22).
  -- It made COMPETING CONFIDENCES unrepresentable: two engine profiles could
  -- not both say "beach" about one photo with different confidence, so the
  -- second write silently replaced the first and the disagreement — the thing
  -- a member would want to see — could not exist. The two partial indexes
  -- below keep every uniqueness that is still true.
) STRICT;

-- table core_transaction
CREATE TABLE core_transaction (
  txn_id                TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES core_account(account_id),
  posted_at             TEXT NOT NULL,
  -- A magnitude, never a signed number (#916, R2 / review 10.2): `direction`
  -- is the sign, and a negative debit meant two contradicting answers.
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  direction             TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  status                TEXT NOT NULL CHECK (status IN ('pending','posted','void')),
  transfer_group_id     TEXT,
  counterparty_party_id TEXT REFERENCES core_party(party_id),
  description           TEXT,
  category_concept_id   TEXT REFERENCES core_concept(concept_id),
  -- NO GLOBAL UNIQUE (#996, ruling R20(c)). A provider-local id is scoped to
  -- its SOURCE: the authoritative key is `sync_external_entity
  -- (connection_id, external_id)`, which `stageCandidates` consults before
  -- any publisher probe. The comment this replaces admitted the right key and
  -- kept the global one anyway, so two institutions' `ref-1` were one
  -- transaction — the second bank's statement line silently merged into the
  -- first's, and the money was gone from the ledger. Two sources may both mint
  -- `ref-1`; a cross-source match is explicit reviewable evidence, never an
  -- equal reference string.
  external_id           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (txn_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table core_vault
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
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (vault_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table enrich_derivation
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

-- table enrich_embedding
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

-- table enrich_policy
CREATE TABLE enrich_policy (
  domain     TEXT PRIMARY KEY CHECK (domain IN ('photos','docs')),
  -- 'local' and 'model' are the pre-#712 tier names, kept legal here as a
  -- read compatibility shim only — see the header comment above.
  tier       TEXT NOT NULL CHECK (tier IN ('off','device','gateway','local','model')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table enrich_policy_rule
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK ((scope_type = 'vault') = (scope_ref = '')),
  CHECK (enabled IS NOT NULL OR profile IS NOT NULL OR trigger_on IS NOT NULL),
  UNIQUE (scope_type, scope_ref, capability)
) STRICT;

-- table enrich_request
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
  -- `target_id` stays NULLable — a search-miss names a TYPE and no row — so
  -- the composite key is enforced only when both halves are present, which is
  -- SQLite's MATCH SIMPLE default (#916).
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table enrich_target_failure
CREATE TABLE enrich_target_failure (
  capability      TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  failures        INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- 1 once the cap is reached: the walk stops offering this target work.
  declined        INTEGER NOT NULL DEFAULT 0 CHECK (declined IN (0, 1)),
  -- Why it is declined, in one token ('failed', 'no-preview', 'too-large').
  reason          TEXT,
  last_error      TEXT,
  first_failed_at TEXT NOT NULL,
  last_failed_at  TEXT NOT NULL,
  PRIMARY KEY (capability, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table fts_conversation
CREATE VIRTUAL TABLE fts_conversation USING fts5(
  conversation_id UNINDEXED,
  title,
  body,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_collection
CREATE VIRTUAL TABLE fts_core_collection USING fts5(
  collection_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_content_item
CREATE VIRTUAL TABLE fts_core_content_item USING fts5(
  content_id UNINDEXED, title,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_document
CREATE VIRTUAL TABLE fts_core_document USING fts5(
  document_id UNINDEXED, title, body,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_event
CREATE VIRTUAL TABLE fts_core_event USING fts5(
  event_id UNINDEXED, summary, description,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_party
CREATE VIRTUAL TABLE fts_core_party USING fts5(
  party_id UNINDEXED, display_name, sort_name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_place
CREATE VIRTUAL TABLE fts_core_place USING fts5(
  place_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_core_transaction
CREATE VIRTUAL TABLE fts_core_transaction USING fts5(
  txn_id UNINDEXED, description,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_knowledge_annotation
CREATE VIRTUAL TABLE fts_knowledge_annotation USING fts5(
  annotation_id UNINDEXED, body_text,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_knowledge_note
CREATE VIRTUAL TABLE fts_knowledge_note USING fts5(
  note_id UNINDEXED, title, body,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_locker_item
CREATE VIRTUAL TABLE fts_locker_item USING fts5(
  item_id UNINDEXED, title, username, url,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_people_profile
CREATE VIRTUAL TABLE fts_people_profile USING fts5(
  profile_id UNINDEXED, role, nickname,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_schedule_project
CREATE VIRTUAL TABLE fts_schedule_project USING fts5(
  project_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_schedule_task
CREATE VIRTUAL TABLE fts_schedule_task USING fts5(
  task_id UNINDEXED, title, description,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_social_circle
CREATE VIRTUAL TABLE fts_social_circle USING fts5(
  circle_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_social_message
CREATE VIRTUAL TABLE fts_social_message USING fts5(
  message_id UNINDEXED, body,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_social_thread
CREATE VIRTUAL TABLE fts_social_thread USING fts5(
  thread_id UNINDEXED, subject,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table fts_tally_expense
CREATE VIRTUAL TABLE fts_tally_expense USING fts5(
  expense_id UNINDEXED, description,
  tokenize = "unicode61 remove_diacritics 2"
);

-- table harness_health
CREATE TABLE harness_health (
  workspace_context    TEXT NOT NULL,
  harness_kind          TEXT NOT NULL,
  failure_class        TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  breaker_until        INTEGER,
  half_open_claimed_at INTEGER,
  last_error           TEXT,
  last_failure_at      INTEGER,
  last_ok_at           INTEGER,
  PRIMARY KEY (workspace_context, harness_kind, failure_class),
  CHECK (failure_class IN ('spawn','auth','init','timeout','quota','wedge','exit','unknown'))
) STRICT;

-- table items
CREATE TABLE items (
  id                 TEXT PRIMARY KEY,
  turn_id            TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL,
  call_id            TEXT,
  batch_id           INTEGER,
  kind               TEXT NOT NULL,
  role               TEXT,
  text               TEXT,
  name               TEXT,
  args_json          TEXT,
  output_json        TEXT,
  raw_json           TEXT,
  child_turn_id      TEXT,
  model              TEXT,
  harness            TEXT,
  -- ACP semantic thought_level confirmed for this call. NULL means the
  -- harness did not confirm a selectable effort; never infer a default.
  effort             TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  -- Provenance for cost_usd (issue #514): 'harness' = harness/ACP reported USD;
  -- 'estimated' = catalog (model-pricing). NULL = legacy or unpriced.
  cost_source        TEXT,
  app_id             TEXT,
  ok                 INTEGER NOT NULL DEFAULT 1,
  error              TEXT,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  duration_ms        INTEGER,
  CHECK (kind IN ('message_in','step','tool','delegate')),
  CHECK (cost_source IS NULL OR cost_source IN ('harness','estimated'))
) STRICT;

-- table knowledge_annotation
CREATE TABLE knowledge_annotation (
  annotation_id   TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  selector_json   TEXT CHECK (selector_json IS NULL OR json_valid(selector_json)),
  body_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (annotation_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table knowledge_note
CREATE TABLE knowledge_note (
  note_id         TEXT PRIMARY KEY,
  author_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title           TEXT NOT NULL,
  body_content_id TEXT NOT NULL REFERENCES core_content_item(content_id),
  -- THE NEWEST REVISION OCCURRENCE (#996, ruling R20(a)), exactly as
  -- `core_document` carries it: a note's body history is the chain of
  -- `core_entity_revision` rows walked from here through
  -- `parent_revision_id`. ON DELETE SET NULL — a pointer into history never
  -- wedges a delete.
  current_revision_id TEXT REFERENCES core_entity_revision(revision_id) ON DELETE SET NULL,
  format          TEXT NOT NULL CHECK (format IN ('markdown','html','plain')),
  pinned          INTEGER NOT NULL CHECK (pinned IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Trash (issue #308 A6): delete is reversible — the soft-delete pair, with
  -- real deletion deferred to the lifecycle sweep's purge window. The FTS
  -- spec's deletedColumn guard keeps trashed notes out of the index. The guard
  -- (issue #441 A4) makes purge_at-without-deleted_at unrepresentable, matching
  -- core_content_item / core_document / media_asset.
  deleted_at      TEXT,
  purge_at        TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (note_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table locker_item
CREATE TABLE locker_item (
  item_id      TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN (
    'login','card','note','identity','wifi','password',
    'ssh_key','api_credential','passport','bank_account','driving_licence',
    'software_licence','crypto_wallet','membership','document')),
  title        TEXT NOT NULL,
  -- login
  username     TEXT,
  password     TEXT,
  url          TEXT,
  url_match_policy TEXT NOT NULL DEFAULT 'registrable-domain'
    CHECK (url_match_policy IN ('registrable-domain','exact-host')),
  otp_seed     TEXT,
  notes        TEXT,
  -- card
  cardholder   TEXT,
  card_number  TEXT,
  expiry       TEXT,
  cvv          TEXT,
  brand        TEXT,
  -- note
  content      TEXT,
  -- identity
  fullname     TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  -- wifi (network; the passphrase reuses the login 'password' column)
  network      TEXT,
  -- The service anchor (issue #310 S3): which broker connection this
  -- credential is FOR, when one exists — "which logins belong to services I
  -- have connections for" becomes a join, and Watchtower can correlate a
  -- breach with the connection that uses the password. Nullable: most items
  -- guard services the vault never talks to.
  connection_id TEXT REFERENCES sync_connection(connection_id),
  -- watchtower: the one stored security fact (breach flag); weak/reused derive
  compromised  INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  -- When the CURRENT password was set (#872, GAPS §3.3 #6d). Stamped by the
  -- write path, never derived from updated_at — an edit that only retags an
  -- item must not make its password look fresh. Nullable: an item with no
  -- password, and a row that predates the column, honestly say "unknown"
  -- rather than claiming an age Review would then reason from.
  password_set_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- archive (#872, GAPS §3.3 #9): "keep forever, hide from lists", the
  -- opposite end of trash's 30-day countdown. Deliberately EXCLUSIVE with
  -- deleted_at rather than orthogonal: an item is live, archived, or trashed,
  -- and the CHECK is what stops a future write inventing a fourth state where
  -- a purge sweep and an archive shelf both claim the same row.
  archived_at  TEXT,
  -- trash: soft-delete keeps the row (and its star) so restore is lossless;
  -- purge_at is set ~30 days out, mirroring Docs. The guard (issue #441 A4)
  -- makes purge_at-without-deleted_at unrepresentable, matching the other
  -- trash-bearing tables.
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL), key_id TEXT,
  CHECK (archived_at IS NULL OR deleted_at IS NULL),
  FOREIGN KEY (item_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table locker_item_address
CREATE TABLE locker_item_address (
  address_id   TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  match_policy TEXT NOT NULL DEFAULT 'registrable-domain'
    CHECK (match_policy IN ('registrable-domain','exact-host')),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (address_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table locker_item_alias
CREATE TABLE locker_item_alias (
  alias      TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- table locker_item_field
CREATE TABLE locker_item_field (
  field_id     TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  -- '' is the item's unnamed leading section, so a field always has one.
  section      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','sealed','url','date','otp')),
  value_text   TEXT,
  value_sealed TEXT,
  -- Owner ordering within (item, section); ties break on label.
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1), key_id TEXT,
  CHECK (kind = 'sealed' OR value_sealed IS NULL),
  CHECK (kind <> 'sealed' OR value_text IS NULL),
  FOREIGN KEY (field_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table locker_item_passkey
CREATE TABLE locker_item_passkey (
  item_id       TEXT PRIMARY KEY REFERENCES locker_item(item_id) ON DELETE CASCADE,
  rp_id         TEXT NOT NULL,
  user_handle   TEXT,
  display_name  TEXT,
  credential_id TEXT,
  algorithm     TEXT,
  private_key   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
, key_id TEXT) STRICT;

-- table locker_key
CREATE TABLE locker_key (
  key_id     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  retired_at TEXT
) STRICT;

-- table media_asset
CREATE TABLE media_asset (
  asset_id         TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  kind             TEXT NOT NULL CHECK (kind IN ('photo','video','audio','scan')),
  -- THE AUTHORED TITLE (#996, ruling R20(b), OQ-9). The owner's own caption
  -- for this photo, moved off `core_content_item.title` where a generated
  -- caption used to overwrite it and where two assets sharing a sha would
  -- have shared one. NULL means the owner has not named it — never an empty
  -- string, and never a machine's words: a GENERATED caption is a derived row
  -- keyed to the representation, and the owner promotes one here with
  -- `media.promote_caption`, which is an AUTHORED write.
  title            TEXT,
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
  -- No `favorite` column (#916, ruling ONT-03). The star was a MIRROR of the
  -- `starred` tag in the flags scheme that Docs, Locker and People already
  -- use, and a mirror has two truths. Archive hides an asset from the timeline
  -- without trashing it; trash is the deleted_at pair below.
  archived_at      TEXT,
  -- The standard soft-delete pair (issue #274): every owner-deletable row
  -- carries its own grace window, not just the drive's content items.
  deleted_at       TEXT,
  purge_at         TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Archived and trashed are different answers, and a row claiming both is
  -- neither (#916).
  CHECK (archived_at IS NULL OR deleted_at IS NULL),
  FOREIGN KEY (asset_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table media_asset_phash
CREATE TABLE media_asset_phash (
  asset_id TEXT PRIMARY KEY REFERENCES media_asset(asset_id) ON DELETE CASCADE,
  phash    TEXT NOT NULL CHECK (length(phash) BETWEEN 4 AND 64),
  -- Near-duplicate cluster projection (issue #352 phase 3/4) — see header.
  cluster_id  TEXT,
  computed_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table media_face_cluster
CREATE TABLE media_face_cluster (
  -- One row per grouped region — a region is in at most one cluster, so the
  -- region is the key and "not in this table" is the honest way to say a face
  -- is ungrouped (named, answered, or alone). No nullable cluster column, no
  -- singleton rows: absence is the absence, not a NULL to interpret.
  region_id   TEXT PRIMARY KEY REFERENCES media_face_region(region_id) ON DELETE CASCADE,
  -- The group's LOWEST region_id (deterministic — see the header).
  cluster_id  TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table media_face_region
CREATE TABLE media_face_region (
  region_id             TEXT PRIMARY KEY,
  asset_id              TEXT NOT NULL REFERENCES media_asset(asset_id),
  bbox_json             TEXT NOT NULL CHECK (json_valid(bbox_json)),
  -- The person this face IS. It yields to their purge rather than blocking it
  -- (#916, D1): forgetting a person must take their name off their faces, and
  -- the CHECK below stays satisfied because a NULL party is always allowed.
  -- `confirmed_by_party_id` does NOT yield — the CHECK ties it to
  -- `review_state`, so a foreign-key SET NULL would leave a 'confirmed' row
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
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
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

-- table media_memory
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

-- table media_memory_member
CREATE TABLE media_memory_member (
  memory_id TEXT NOT NULL REFERENCES media_memory(memory_id) ON DELETE CASCADE,
  asset_id  TEXT NOT NULL REFERENCES media_asset(asset_id) ON DELETE CASCADE,
  -- Display order within the memory (capture order). Not UNIQUE per memory:
  -- ties (same captured_at) share an ordinal rather than an arbitrary
  -- tiebreak deciding which photo "comes first".
  ordinal   INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (memory_id, asset_id)
) STRICT;

-- table notifications_notice
CREATE TABLE notifications_notice (
  notice_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  headline TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','high')),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  read_at TEXT,
  archived_at TEXT,
  UNIQUE(kind, source_ref)
) STRICT;

-- table outbox_item
CREATE TABLE outbox_item (
  item_id              TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sync_connection(connection_id),
  actor_id             TEXT NOT NULL,
  actor_kind           TEXT NOT NULL CHECK (actor_kind IN ('owner','app','ai_agent')),
  verb                 TEXT NOT NULL,
  target               TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  recipient_party_id   TEXT REFERENCES core_party(party_id),
  artifact_json        TEXT NOT NULL CHECK (json_valid(artifact_json)),
  request_json         TEXT NOT NULL CHECK (json_valid(request_json)),
  status               TEXT NOT NULL CHECK (status IN ('pending','approved','sent','discarded','failed')),
  -- The standing answer that auto-approved this item, in the ONE id space
  -- every receipt cites (#928). NULL = the member decided this item itself.
  authority_id         TEXT REFERENCES share_authority(authority_id),
  staged_at            TEXT NOT NULL,
  decided_at           TEXT,
  drained_at           TEXT,
  result_json          TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  published_message_id TEXT REFERENCES social_message(message_id),
  note                 TEXT,
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  -- A REAL reference (#916, E1). This was an audit value — "the row this was
  -- about" — and that reading is wrong for a queue: an item still PENDING when
  -- its subject is purged would drain afterwards and publish an artifact about
  -- a row the member deleted. The pair is a composite key into the entity
  -- supertype and cascades, so a purge empties the queue of anything about it.
  -- A NULL pair (an outbound write with no canonical subject) satisfies a
  -- composite foreign key by definition, which is the right reading.
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table people_important_date
CREATE TABLE people_important_date (
  date_id     TEXT PRIMARY KEY,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  label       TEXT NOT NULL,
  -- Recurs annually: stored as MM-DD, the year is meaningless to a birthday.
  -- A REAL DAY, FOR EVERY WRITER (#996, ruling R21; drift ONT-26).
  -- `people.add_important_date` refused February 31 in its input schema and
  -- `atlas.insert_row` wrote it, because the only CHECK here was the length.
  -- 2000 is a leap year, so 02-29 — a real anniversary — passes, and the
  -- round-trip is what catches 02-31: `date()` normalises rather than refuses.
  month_day   TEXT NOT NULL CHECK (
    length(month_day) = 5
    AND date('2000-' || month_day) = '2000-' || month_day
  ),
  reminder_on INTEGER NOT NULL CHECK (reminder_on IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Trash pair + guard (issue #441 A4).
  deleted_at  TEXT,
  purge_at    TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (date_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table people_profile
CREATE TABLE people_profile (
  profile_id        TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  role              TEXT,
  -- The owner's short name for this person (#883, ruling O-contact): the
  -- retired `social.contact_card` held it, and reachability moved to
  -- `social.contact_channel` while the display facts landed here.
  nickname          TEXT,
  avatar_color      TEXT,
  -- 0 means "never" — cadence disabled (issue #821). Some people the owner
  -- keeps are people they never want nagged about, and the floor of 1 day had
  -- no way to say so; a zero-cadence person is never overdue. Negative days
  -- stay refused: the CHECK is the storage floor, and the People command
  -- schemas above it carry the same minimum of 0.
  cadence_days      INTEGER NOT NULL CHECK (cadence_days >= 0),
  -- Ground fact, NOT a projection (issue #441 A3): last_contacted_at is stamped
  -- by an explicit owner gesture — logging an interaction (people.log_interaction)
  -- sets it to now, and that is the only writer. It is deliberately NOT a cache
  -- of MAX(core_activity.started_at) through a live about-link: a logged touch is what clears
  -- "overdue", and the owner may log a touch with no interaction body, or keep
  -- an interaction they later trash without un-clearing overdue. So it needs no
  -- rebuild sweep — there is nothing to reconcile it against.
  last_contacted_at TEXT,
  met               TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Trash (#630 P5): trashing the profile hides the person from the People
  -- projection while the canonical party, its links and its Tally
  -- participation stay, so restore is lossless until the sweep purges.
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (profile_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table replica_intent_outcome
CREATE TABLE replica_intent_outcome (
  intent_id     TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  action        TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (
    status IN ('queued','sending','parked','executed','denied','failed','conflict')
  ),
  invocation_id TEXT,
  reason        TEXT,
  conflict_json TEXT CHECK (conflict_json IS NULL OR json_valid(conflict_json)),
  -- WHO A PARKED WRITE IS WAITING ON (#929): 'owner' when the origin's member
  -- must decide it, 'origin' when the write is queued for the vault that owns
  -- the container, 'gateway' when the host cannot carry it yet. The seat draws
  -- a person from it, so the label rides along — read off the LINK, never a
  -- vault id a member has no name for.
  waiting_on    TEXT CHECK (waiting_on IS NULL OR json_valid(waiting_on)),
  -- The ORIGIN row versions this intent's answer stands for (#929, G1). A
  -- member's pending row drops only when their replica holds them; without the
  -- versions the seat would have to guess, and the guess is what makes a
  -- pending badge clear before the row it wrote arrives.
  answered_versions TEXT
    CHECK (answered_versions IS NULL OR json_valid(answered_versions)),
  -- THE CANONICAL COMMIT POSITION THIS ANSWER STANDS FOR (#996, R24). Every
  -- executed outcome carries it, on the device path as well as the peer path,
  -- and a seat keeps its pending projection until its applied cursor reaches
  -- it. Without the number the seat has to guess, and the guess is what makes
  -- a pending badge clear before the row it wrote arrives.
  commit_seq    INTEGER CHECK (commit_seq IS NULL OR commit_seq > 0),
  -- The (table, pk, row_version) set this intent's commit produced, read from
  -- the captured rows rather than re-queried: a second read could see a LATER
  -- commit's value and settle the intent against work it did not do.
  produced_json TEXT CHECK (produced_json IS NULL OR json_valid(produced_json)),
  -- THE INTENTS THIS ONE WAITS ON (#996, R23). A JSON array of intent ids: an
  -- offline chain is causal, so a rename cannot execute before the create it
  -- renames, and the gateway is where that is enforced rather than in each
  -- app's retry loop.
  depends_on    TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)),
  -- THE END OF THE IDEMPOTENCY WINDOW (#996, R24 / OQ-13). A retry after this
  -- gets an explicit 'expired' answer naming what to do, never a silent
  -- re-execution: the retained outcome is what makes a retry safe, so when it
  -- is gone the honest answer is "I no longer know", not "here, do it again".
  expires_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table replica_invocation_commit
CREATE TABLE replica_invocation_commit (
  invocation_id       TEXT PRIMARY KEY,
  command_id          TEXT NOT NULL,
  intent_id           TEXT,
  -- Redacted/non-secret post-check + S5 reconstruction material. This row is
  -- in the canonical transaction, so replay can finish the audit band without
  -- re-entering the command handler after a crash.
  audit_json          TEXT NOT NULL CHECK (json_valid(audit_json)),
  committed_at        TEXT NOT NULL,
  -- Set only after one atomic audit-band transaction has verified checks,
  -- provenance, receipt, evidence, explanation, and executed status.
  journal_finalized_at TEXT
) STRICT;

-- table replica_log
CREATE TABLE replica_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The canonical commit position every row of one transaction shares. An
  -- intent's durable outcome names it (R24), and a seat applies one commit
  -- per transaction with its cursor in the same transaction.
  commit_seq      INTEGER NOT NULL CHECK (commit_seq > 0),
  epoch           TEXT NOT NULL,
  -- Two numbers, never one (R5): compatibility, then additive progress.
  schema_epoch    INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version     INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  -- PHYSICAL table name, not a logical entity: a seat holds the gateway's
  -- schema and applies to the same table the gateway wrote.
  "table"         TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('insert','update','delete','ddl')),
  -- The primary key as a JSON array, in declared key order — one element for
  -- the ordinary case, several for a composite key. An array, not a scalar,
  -- so a composite key needs no separator nobody can escape.
  pk_json         TEXT NOT NULL CHECK (json_valid(pk_json)),
  -- The full new row image for insert/update; the full OLD image for delete,
  -- which is the only image a delete has and what a subscriber needs to judge
  -- that the row left its closure. A `ddl` row carries its statement here.
  row_json        TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  -- 1 when the session flagged the change as trigger- or cascade-produced.
  -- Carried, not filtered: a cascaded delete is a real row a seat must apply,
  -- and the flag is what lets a reader tell it from a writer's own statement.
  indirect        INTEGER NOT NULL DEFAULT 0 CHECK (indirect IN (0,1)),
  -- What produced the commit — a command name, an import, the enricher. The
  -- producer bound is denominated per producer, so this is how a bulk writer
  -- is recognised without guessing from row counts.
  producer        TEXT NOT NULL,
  -- 1 when this commit's compressed size crossed the defer threshold, so a
  -- metered seat may skip it and stay CONSISTENT BEHIND IT rather than
  -- half-applied. Every row of one commit carries the same value: a commit is
  -- the unit a seat applies, so it is the unit a seat defers.
  deferred        INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0,1)),
  committed_at    TEXT NOT NULL
, prior_json TEXT
  CHECK (prior_json IS NULL OR json_valid(prior_json)), local INTEGER NOT NULL DEFAULT 0
  CHECK (local IN (0,1))) STRICT;

-- table replica_meta
CREATE TABLE replica_meta (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch            TEXT NOT NULL,
  floor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (floor_seq >= 0),
  schema_epoch     INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version      INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  -- The last commit position handed out. Allocated inside the capturing
  -- transaction, so a rolled-back commit leaves no gap a reader can see.
  commit_seq       INTEGER NOT NULL DEFAULT 0 CHECK (commit_seq >= 0),
  active_commit_id TEXT,
  epoch_reason     TEXT NOT NULL DEFAULT 'created',
  epoch_started_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

-- table replica_parked_payload
CREATE TABLE replica_parked_payload (
  invocation_id TEXT PRIMARY KEY,
  intent_id     TEXT,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  request_sealed TEXT NOT NULL,
  grant_id      TEXT,
  command_id    TEXT NOT NULL,
  command_name  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  parked_at     TEXT NOT NULL
) STRICT;

-- table schedule_attendee
CREATE TABLE schedule_attendee (
  attendee_id  TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES core_event(event_id),
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  role         TEXT NOT NULL CHECK (role IN ('chair','required','optional')),
  partstat     TEXT NOT NULL CHECK (partstat IN ('needs-action','accepted','declined','tentative')),
  responded_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (event_id, party_id),
  FOREIGN KEY (attendee_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_calendar
CREATE TABLE schedule_calendar (
  calendar_id    TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  color          TEXT,
  default_tz     TEXT NOT NULL,
  visibility     TEXT NOT NULL CHECK (visibility IN ('private','shared','public')),
  external_uri   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (calendar_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_event_ext
CREATE TABLE schedule_event_ext (
  event_ext_id      TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE REFERENCES core_event(event_id),
  calendar_id       TEXT NOT NULL REFERENCES schedule_calendar(calendar_id),
  busy              TEXT NOT NULL CHECK (busy IN ('busy','free')),
  conferencing_uri  TEXT,
  reminders_json    TEXT CHECK (reminders_json IS NULL OR json_valid(reminders_json)),
  travel_buffer_min INTEGER CHECK (travel_buffer_min >= 0),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (event_ext_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_project
CREATE TABLE schedule_project (
  project_id     TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  area           TEXT,
  color          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (project_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_recurrence_exception
CREATE TABLE schedule_recurrence_exception (
  exception_id  TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('core.event','tally.recurring_expense')),
  target_id     TEXT NOT NULL,
  -- The series-local wall clock of the occurrence, in the series' own zone —
  -- never a UTC instant, and never suffixed 'Z' unless the series is itself
  -- UTC.
  original_start_local TEXT NOT NULL,
  -- The series' reading of that wall clock, copied at write time so the
  -- exception can be matched without re-reading the series.
  recurrence_semantics TEXT NOT NULL
    CHECK (recurrence_semantics IN ('zoned','floating','all-day')),
  scope         TEXT NOT NULL DEFAULT 'occurrence'
    CHECK (scope IN ('occurrence','future')),
  action        TEXT NOT NULL CHECK (action IN ('skip','override')),
  -- A shadow event is DELIBERATELY one row: start, end, summary and reminders
  -- are the overriding occurrence's own values and have no life apart from it.
  -- `attendee_party_ids` left this JSON under #916 (R6 / review 10.4) —
  -- party ids inside a JSON blob are invisible to identity merge and to the
  -- purge cascade, so they are rows in
  -- `schedule_recurrence_exception_attendee` below.
  override_json TEXT CHECK (
    (action = 'skip' AND override_json IS NULL)
    OR (action = 'override' AND override_json IS NOT NULL AND json_valid(override_json))
  ),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (target_type, target_id, original_start_local, scope),
  FOREIGN KEY (exception_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_recurrence_exception_attendee
CREATE TABLE schedule_recurrence_exception_attendee (
  exception_id TEXT NOT NULL
    REFERENCES schedule_recurrence_exception(exception_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (exception_id, party_id)
) STRICT;

-- table schedule_section
CREATE TABLE schedule_section (
  section_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES schedule_project(project_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (section_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table schedule_task
CREATE TABLE schedule_task (
  task_id        TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title          TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('needs-action','in-process','completed','cancelled')),
  priority       INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 9),
  -- TEMPORAL MEANING IS CHECKED WHERE IT IS STORED (#996, ruling R21; drift
  -- ONT-31). `due_at: "banana"` used to store, and completion then had
  -- nothing to advance — an unreadable due date is indistinguishable from no
  -- due date at read time, so a repeating task simply stopped and nothing said
  -- why. The round-trip on the date part is what refuses February 31:
  -- `date()` NORMALISES a bad day rather than rejecting it, so
  -- `date('2026-02-31')` is `'2026-03-02'` and only the comparison notices.
  -- A CHECK because it is a simple invariant (R21) and therefore true for
  -- every writer, Atlas and the seat's local apply included.
  due_at         TEXT CHECK (
    due_at IS NULL
    OR (datetime(due_at) IS NOT NULL
        AND date(substr(due_at, 1, 10)) = substr(due_at, 1, 10))
  ),
  completed_at   TEXT,
  effort_min     INTEGER CHECK (effort_min > 0),
  -- A TASK IS NOT ITS OWN PARENT (#996, R21; drift ONT-26). Atlas accepted it;
  -- the domain command never checked it. Longer loops are the
  -- `schedule_task_hierarchy_is_acyclic` trigger in `time-organize.ts`,
  -- which needs the recursive walk this CHECK cannot do.
  parent_task_id TEXT REFERENCES schedule_task(task_id)
    CHECK (parent_task_id IS NULL OR parent_task_id <> task_id),
  rrule          TEXT,
  remind_before_min INTEGER CHECK (remind_before_min >= 0),
  -- The trash pair (#883, ruling O-trash): a task the member deleted leaves
  -- every surface at once, search included (#916, R11).
  deleted_at     TEXT,
  purge_at       TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1), project_id TEXT
  REFERENCES schedule_project(project_id) ON DELETE SET NULL, section_id TEXT
  REFERENCES schedule_section(section_id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, recurrence_anchor TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (recurrence_anchor IN ('scheduled','completion')), tz TEXT, series_id TEXT
  REFERENCES schedule_task(task_id) ON DELETE SET NULL,
  FOREIGN KEY (task_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table share_authority
CREATE TABLE share_authority (
  authority_id   TEXT PRIMARY KEY,
  -- 'automation' is ACCEPTED here with no writer yet: #928 wave 3 writes it,
  -- when an automation's compiled manifest mints one row per (pack or entity
  -- x read|act) and the owner's refusals become 'declined' rows. Accepting it
  -- a wave early is what lets that wave land without a schema change. The
  -- 'app' kind is deliberately NOT here — first-party apps are not principals
  -- (#928 A1), and a third-party door would be a new answer, not a new value.
  -- 'device' LEFT this vocabulary (#996, R17). Enrollment is full trust
  -- (R11): a seat either holds this vault or it does not, and that is
  -- `access_device`'s answer, not a standing one the member gave. Keeping it
  -- here made "which surfaces may this seat reach" expressible in the same
  -- table as "who may see this album", and row-level scoping exists in exactly
  -- one place in the system -- the closure of a shared subject.
  principal_kind TEXT NOT NULL CHECK (principal_kind IN
    ('person','circle','harness','automation')),
  principal_id   TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  -- '' where the subject is the whole of something the principal is already
  -- scoped to: every scope, for a vault-wide egress
  -- answer. Same empty-string argument as enrich_policy_rule.scope_ref — a NULL
  -- would let one vault-wide answer be recorded twice under the live index.
  subject_id     TEXT NOT NULL,
  -- Per (principal_kind x subject_type) vocabulary, not one global union:
  -- 'view'/'edit' for a share, the enrichment capability for an egress
  -- answer. The registry that closes those
  -- triples is ruling V-registry's, and lands with the share.* command pack.
  verb           TEXT NOT NULL CHECK (length(verb) BETWEEN 1 AND 64),
  duration       TEXT NOT NULL CHECK (duration IN ('standing','until-date')),
  expires_at     TEXT,
  -- A refusal is an ANSWER, not an absent grant (ruling V-table): forgetting a
  -- 'declined' row would make "asked and told no" indistinguishable from "never
  -- asked", and it is what ruling V-mask's per-party refusal mask is written as.
  decision       TEXT NOT NULL CHECK (decision IN ('granted','declined')),
  granted_at     TEXT NOT NULL,
  -- The party who answered. NULL only where the member answered about their own
  -- machinery and no actor party was ever recorded (the egress answers carry
  -- none); the CHECK below keeps every person/circle row honest, which is what
  -- makes grant/grant-store.ts's non-null narrowing sound.
  granted_by     TEXT REFERENCES core_party(party_id),
  revoked_at     TEXT,
  -- Why the answer ended, when it ended for a reason the member did not state
  -- in the moment (#916, E2): the purge of the subject revokes every live
  -- answer about it through a trigger on `core_entity`, and 'subject-purged'
  -- is what that trigger writes. NULL for an ordinary owner revoke, where the
  -- receipt is the reason.
  revoked_reason TEXT,
  -- -> access.receipt, in the append-only audit band. A VALUE, not a key: an
  -- audit outlives its subject (#916). NULL until the receipt is written,
  -- never a second copy of it.
  receipt_id     TEXT,
  CHECK ((duration = 'until-date') = (expires_at IS NOT NULL)),
  -- 'automation' is deliberately NOT exempted: the owner APPROVES an
  -- automation's manifest, so there is always a party who answered, and a row
  -- minted without one would be an automation that granted itself (#928 A3).
  CHECK (granted_by IS NOT NULL OR principal_kind = 'harness'),
  -- The one principal whose id is a closed vocabulary rather than a row id:
  -- a harness principal is an ENGINE CLASS, and an egress class outside the
  -- three enrich-gate.ts knows is unrepresentable here exactly as it was
  -- unrepresentable in `enrich_consent.egress` (#807).
  CHECK (principal_kind <> 'harness'
         OR principal_id IN ('on-device','gateway','provider'))
) STRICT;

-- table share_authority_request
CREATE TABLE share_authority_request (
  request_id   TEXT PRIMARY KEY,
  -- The automation's own id (its enrolment key), the same principal id
  -- `share_authority.principal_id` carries for an 'automation' row.
  principal_id TEXT NOT NULL,
  scopes_json  TEXT NOT NULL CHECK (json_valid(scopes_json)),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decision     TEXT CHECK (decision IN ('approved','denied'))
) STRICT;

-- table share_authority_use
CREATE TABLE share_authority_use (
  authority_id TEXT PRIMARY KEY,
  last_used_at TEXT NOT NULL
) STRICT;

-- table share_delivery_config
CREATE TABLE share_delivery_config (
  grant_id         TEXT PRIMARY KEY
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  max_size_bytes   INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0),
  departure_policy TEXT NOT NULL DEFAULT 'remove-member-only'
    CHECK (departure_policy IN ('remove-member-only','retain-ledger-history'))
) STRICT;

-- table share_fulfillment
CREATE TABLE share_fulfillment (
  grant_id      TEXT NOT NULL
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  peer_vault_id TEXT NOT NULL,
  -- awaiting_channel means the peer vault is known and the link to it has
  -- ended (#903). It is deliberately NOT narrowed out of this CHECK: that
  -- state is still reachable — link, share, then unlink — and only the
  -- retired reading of it ("waiting on an invitation to be claimed") is gone.
  state         TEXT NOT NULL CHECK (state IN
    ('awaiting_channel','syncing','delivered','remove_sent','removed')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Latest note: a refusal reason, a transport error, why a removal stalled.
  detail        TEXT,
  -- When the subject first reached this peer. NULL = never delivered.
  delivered_at  TEXT,
  PRIMARY KEY (grant_id, peer_vault_id)
) STRICT;

-- table share_party_vault_binding
CREATE TABLE share_party_vault_binding (
  binding_id TEXT PRIMARY KEY,
  party_id   TEXT NOT NULL REFERENCES core_party(party_id),
  vault_id   TEXT NOT NULL,
  vault_public_key TEXT,
  linked_at  TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (party_id, vault_id)
) STRICT;

-- table share_subscription
CREATE TABLE share_subscription (
  -- NO FOREIGN KEY to `share_authority`, deliberately: the AUDIENCE holds this
  -- row and never holds the origin's answer. Same reading as the member seat's
  -- intent overlay — a key here would make holding the subscription depend on
  -- holding the grant that authorizes it, which only the origin has.
  authority_id      TEXT NOT NULL,
  audience_vault_id TEXT NOT NULL,
  origin_vault_id   TEXT NOT NULL,
  -- Derivable from `share_authority` on the ORIGIN and only there: the
  -- audience never holds the grant, so its own row has to carry the subject.
  subject_type      TEXT NOT NULL,
  -- The origin's replica epoch this cursor is measured in. A changed epoch is
  -- a re-bootstrap, exactly as it is for a device (the phone's rule): the seat
  -- does not extend a floor on a subscriber's behalf.
  cursor_epoch      TEXT,
  cursor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  -- 'removed' is the audience's own acknowledgement that the grant's rows are
  -- gone. The origin's `share_fulfillment` vocabulary is untouched.
  state             TEXT NOT NULL CHECK (state IN ('subscribed','removed')),
  subscribed_at     TEXT NOT NULL,
  removed_at        TEXT,
  detail            TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (authority_id, audience_vault_id)
) STRICT;

-- table share_subscription_lineage
CREATE TABLE share_subscription_lineage (
  authority_id       TEXT NOT NULL,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  origin_item_id     TEXT NOT NULL,
  origin_row_version INTEGER NOT NULL CHECK (origin_row_version >= 0),
  audience_row_version INTEGER NOT NULL DEFAULT 0
    CHECK (audience_row_version >= 0),
  PRIMARY KEY (authority_id, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table share_subscription_member
CREATE TABLE share_subscription_member (
  authority_id TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  pk           TEXT NOT NULL,
  entered_seq  INTEGER NOT NULL CHECK (entered_seq >= 0),
  PRIMARY KEY (authority_id, table_name, pk)
) STRICT;

-- table social_circle
CREATE TABLE social_circle (
  circle_id      TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('family','friends','work','custom')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (owner_party_id, name),
  FOREIGN KEY (circle_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table social_circle_member
CREATE TABLE social_circle_member (
  member_id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL REFERENCES social_circle(circle_id),
  party_id  TEXT NOT NULL REFERENCES core_party(party_id),
  added_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1), capability TEXT NOT NULL DEFAULT 'read'
  CHECK (capability IN ('read','read+write')),
  UNIQUE (circle_id, party_id),
  FOREIGN KEY (member_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table social_contact_channel
CREATE TABLE social_contact_channel (
  channel_id       TEXT PRIMARY KEY,
  party_id         TEXT NOT NULL REFERENCES core_party(party_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('phone','email','address','handle')),
  label            TEXT,
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_preferred     INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0,1)),
  provenance_json  TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (party_id, kind, normalized_value),
  FOREIGN KEY (channel_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table social_message
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
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (sender_party_id IS NOT NULL OR sender_handle IS NOT NULL),
  FOREIGN KEY (message_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table social_thread
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
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (thread_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table social_thread_participant
CREATE TABLE social_thread_participant (
  tp_id     TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES social_thread(thread_id),
  party_id  TEXT REFERENCES core_party(party_id),
  handle    TEXT,
  joined_at TEXT,
  muted     INTEGER NOT NULL CHECK (muted IN (0,1)),
  last_read_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (thread_id, party_id),
  CHECK (party_id IS NOT NULL OR handle IS NOT NULL),
  FOREIGN KEY (tp_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table sync_connection
CREATE TABLE sync_connection (
  connection_id TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  principal     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','needs-auth','failing','paused')),
  trust         TEXT NOT NULL CHECK (trust IN ('staged','auto-publish')),
  -- Per-class standing consent for enrichment (issue #310 C3): NULL means
  -- auto-publish trust covers every derived-data class; a JSON array
  -- (['caption','tag','face','collection','filing']) narrows it — classes
  -- outside it stage as drafts for review instead of landing silently.
  enrich_classes_json TEXT CHECK (enrich_classes_json IS NULL OR json_valid(enrich_classes_json)),
  created_at    TEXT NOT NULL,
  last_run_at   TEXT,
  UNIQUE (kind, label)
) STRICT;

-- table sync_connection_credential
CREATE TABLE sync_connection_credential (
  connection_id    TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  cred_kind        TEXT NOT NULL CHECK (cred_kind IN ('oauth2','api_key')),
  oauth_mode       TEXT NOT NULL DEFAULT 'byo' CHECK (oauth_mode IN ('byo','assist')),
  provider         TEXT,
  auth_url         TEXT,
  token_url        TEXT,
  scopes           TEXT,
  client_id        TEXT,
  client_secret    TEXT,
  access_token     TEXT,
  refresh_token    TEXT,
  api_key          TEXT,
  token_expires_at TEXT,
  allowed_hosts    TEXT NOT NULL CHECK (json_valid(allowed_hosts)),
  -- The exchange-minted HMAC capability an Assist refresh token is redeemable
  -- at the OAuth Worker with (#865). Sealed, re-persisted on every rotation.
  refresh_capability TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table sync_connection_cursor
CREATE TABLE sync_connection_cursor (
  cursor_id     TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (connection_id, key)
) STRICT;

-- table sync_connection_health
CREATE TABLE sync_connection_health (
  connection_id TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  auth_note     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- table sync_connection_run
CREATE TABLE sync_connection_run (
  run_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running','ok','failed','aborted')) ,
  staged        INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  error         TEXT
) STRICT;

-- table sync_external_entity
CREATE TABLE sync_external_entity (
  map_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  gone_upstream INTEGER NOT NULL CHECK (gone_upstream IN (0,1)) DEFAULT 0,
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;

-- table sync_import_batch
CREATE TABLE sync_import_batch (
  batch_id      TEXT PRIMARY KEY,
  -- NO CASCADE, deliberately (#916, W2a): a batch is RECEIPTED HISTORY — what
  -- was imported, when, and what it became — so removing the connection is
  -- REFUSED while any exists rather than shredding the record of it.
  -- `sync.remove_connection` says so in its denial.
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  status        TEXT NOT NULL CHECK (status IN ('draft','published','discarded')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  summary_json  TEXT NOT NULL CHECK (json_valid(summary_json))
) STRICT;

-- table sync_import_row
CREATE TABLE sync_import_row (
  row_id              TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL
    REFERENCES sync_import_batch(batch_id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  entity_type         TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),
  disposition         TEXT NOT NULL CHECK (disposition IN ('create','update','skip','merge-candidate')),
  target_entity_id    TEXT,
  published_entity_id TEXT,
  note                TEXT
) STRICT;

-- table tally_expense
CREATE TABLE tally_expense (
  expense_id   TEXT PRIMARY KEY,
  -- NULL for a group-less 1:1 expense (GAPS #4), mirroring how a settlement
  -- has always been free-standing. Participants on a group-less expense are
  -- validated against the friend roster instead of a circle.
  group_id     TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- The currency `amount_minor` IS (#916, R1). Splits, payers and line items
  -- inherit it BY CONSTRUCTION — they are shares of this amount and cannot be
  -- denominated in anything else, so none of them carries a column. A trigger
  -- (`tally_expense_currency_matches_group`, below) holds a grouped expense
  -- to its group's currency; a group-less 1:1 expense is free to be in any.
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  -- The PRINCIPAL payer, always populated and always one of the payer rows.
  -- Every expense also writes its full payer set to tally_expense_payer (one
  -- degenerate row in the single-payer case), so a reader that only knows this
  -- column stays right for the single-payer case and the folds read one shape.
  paid_by      TEXT NOT NULL REFERENCES core_party(party_id),
  -- How the shares were arrived at, so an edit re-opens the way it was
  -- entered. The vault still stores RESOLVED shares — the method and its
  -- parameters are provenance, never a second arithmetic path.
  split_method TEXT NOT NULL DEFAULT 'exact' CHECK (split_method IN
    ('equally','exact','percentages','shares','adjusted','by_line')),
  split_params_json TEXT
    CHECK (split_params_json IS NULL OR json_valid(split_params_json)),
  spent_on     TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN
    ('food','groceries','rent','utilities','transport','fun','travel','shopping','general')),
  txn_id       TEXT REFERENCES core_transaction(txn_id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Trash pair + guard (issue #441 A4). tally_expense_split cascades on purge.
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL), original_amount_minor INTEGER
  CHECK (original_amount_minor IS NULL OR original_amount_minor > 0), original_currency TEXT
  CHECK (original_currency IS NULL OR length(original_currency) = 3), settlement_currency TEXT
  CHECK (settlement_currency IS NULL OR length(settlement_currency) = 3), rate_scaled INTEGER
  CHECK (rate_scaled IS NULL OR rate_scaled > 0), rate_scale INTEGER
  CHECK (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 12), rate_source TEXT, rate_date TEXT, recurring_template_id TEXT
  REFERENCES tally_recurring_expense(template_id) ON DELETE SET NULL,
  FOREIGN KEY (expense_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_expense_line_allocation
CREATE TABLE tally_expense_line_allocation (
  line_item_id TEXT NOT NULL REFERENCES tally_expense_line_item(line_item_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (line_item_id, party_id)
) STRICT;

-- table tally_expense_line_item
CREATE TABLE tally_expense_line_item (
  line_item_id TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  -- The role='receipt' attachment this line was read off, or NULL for the
  -- "By line" division that never had a photo (#883).
  receipt_id   TEXT REFERENCES core_attachment(attachment_id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('item','tax','tip')),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (line_item_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_expense_payer
CREATE TABLE tally_expense_payer (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  paid_minor  INTEGER NOT NULL CHECK (paid_minor >= 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (expense_id, party_id)
) STRICT;

-- table tally_expense_split
CREATE TABLE tally_expense_split (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (expense_id, party_id)
) STRICT;

-- table tally_friend
CREATE TABLE tally_friend (
  friend_id    TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (friend_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_group
CREATE TABLE tally_group (
  group_id   TEXT PRIMARY KEY,
  circle_id  TEXT NOT NULL UNIQUE REFERENCES social_circle(circle_id),
  icon       TEXT NOT NULL,
  color      TEXT NOT NULL,
  -- Debt simplification rewires who owes whom, so it is OFF unless this group
  -- turns it on. The flag is the ONLY thing stored: the proposal itself is
  -- derived at read time and never written, and an accepted proposal is
  -- recorded as ordinary settlements.
  simplify_opt_in INTEGER NOT NULL DEFAULT 0
    CHECK (simplify_opt_in IN (0,1)),
  -- Archive is not delete: an archived group drops out of the default lists
  -- and keeps every row. It needs no settled balance.
  archived_at TEXT,
  -- THE GROUP'S CURRENCY (#916, R1 / review 4.1). Splitwise's own model puts
  -- the currency on the group and every expense in it agrees; the vault stored
  -- amounts in minor units with no currency at all outside
  -- `tally_obligation` and the cross-currency columns, so two expenses in
  -- different currencies summed as if they were the same money. The group is
  -- where it belongs, because a group is the ledger everyone in it reads.
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (group_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_nudge
CREATE TABLE tally_nudge (
  nudge_id     TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  group_id     TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  -- The net the owner saw when they prepared it, in minor units. Provenance
  -- for the reminder's wording — never read back as a balance.
  as_of_minor  INTEGER NOT NULL,
  note         TEXT,
  prepared_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (nudge_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_obligation
CREATE TABLE tally_obligation (
  obligation_id TEXT PRIMARY KEY,
  from_party    TEXT NOT NULL REFERENCES core_party(party_id),
  to_party      TEXT NOT NULL REFERENCES core_party(party_id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  reason        TEXT,
  incurred_on   TEXT NOT NULL,
  settled_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  deleted_at    TEXT,
  purge_at      TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (from_party <> to_party),
  FOREIGN KEY (obligation_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_recurring_expense
CREATE TABLE tally_recurring_expense (
  template_id           TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL
    REFERENCES tally_group(group_id) ON DELETE CASCADE,
  description           TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL CHECK (original_amount_minor > 0),
  original_currency     TEXT NOT NULL CHECK (length(original_currency) = 3),
  settlement_currency   TEXT NOT NULL CHECK (length(settlement_currency) = 3),
  paid_by               TEXT NOT NULL REFERENCES core_party(party_id),
  category              TEXT NOT NULL,
  -- The split is ROWS (#916, owner decision D3), in
  -- `tally_recurring_expense_split` below. It used to be a JSON array of
  -- {party_id, share} objects, which put party ids somewhere identity merge
  -- could not see them, the purge cascade could not reach them, and no CHECK
  -- could hold their shares to the template's amount.
  rrule                 TEXT NOT NULL,
  anchor_start          TEXT NOT NULL,
  -- `tz`, not `time_zone` (#916, R4): one name for a zone column.
  tz                    TEXT NOT NULL,
  rate_scaled           INTEGER CHECK (rate_scaled IS NULL OR rate_scaled > 0),
  rate_scale            INTEGER CHECK (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 12),
  rate_source           TEXT,
  rate_date             TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','ended')),
  last_materialized_start TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (template_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table tally_recurring_expense_split
CREATE TABLE tally_recurring_expense_split (
  template_id  TEXT NOT NULL
    REFERENCES tally_recurring_expense(template_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (template_id, party_id)
) STRICT;

-- table tally_settlement
CREATE TABLE tally_settlement (
  settlement_id TEXT PRIMARY KEY,
  -- NULL for a free-standing friend-to-friend payment (not scoped to a group).
  group_id      TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  from_party    TEXT NOT NULL REFERENCES core_party(party_id),
  to_party      TEXT NOT NULL REFERENCES core_party(party_id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  -- What was PAID, in the currency it was paid in (#916, R1). The trigger
  -- below holds a grouped settlement to its group's currency.
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  paid_on       TEXT NOT NULL,
  txn_id        TEXT REFERENCES core_transaction(txn_id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Trash pair + guard (issue #441 A4).
  deleted_at    TEXT,
  purge_at      TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  -- A payment from someone to themselves is not a payment (#916, R2 / review
  -- 10.2). `tally_obligation` has carried this CHECK since #450; the
  -- settlement did not, which is how `core.merge_party` could fold two
  -- parties into one and leave a self-payment behind that every balance then
  -- counted twice.
  CHECK (from_party <> to_party),
  FOREIGN KEY (settlement_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table trigger_ingress
CREATE TABLE trigger_ingress (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  delivery_id   TEXT NOT NULL,
  received_at   INTEGER NOT NULL,
  payload_json  TEXT,
  payload_ref   TEXT,
  expires_at    INTEGER NOT NULL,
  UNIQUE (source, source_key, delivery_id),
  CHECK (source IN ('webhook','poll')),
  CHECK (payload_json IS NOT NULL OR payload_ref IS NOT NULL)
) STRICT;

-- table turns
CREATE TABLE turns (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq                      INTEGER NOT NULL,
  parent_turn_id           TEXT,
  trigger                  TEXT NOT NULL,
  trigger_origin           TEXT,
  note                     TEXT,
  summary                  TEXT,
  output_json              TEXT,
  retry_of                 TEXT,
  idempotency_key          TEXT,
  -- Explicit handoff-cost marker (D4): estimated canonical-ledger prompt
  -- tokens injected on this turn, separate from ACP-reported usage.
  hydration_tokens         INTEGER,
  ok                       INTEGER NOT NULL DEFAULT 0,
  error                    TEXT,
  feedback                 TEXT,
  pinned                   INTEGER NOT NULL DEFAULT 0,
  started_at               INTEGER NOT NULL,
  ended_at                 INTEGER,
  total_input_tokens       INTEGER,
  total_output_tokens      INTEGER,
  total_cache_read_tokens  INTEGER,
  total_cache_write_tokens INTEGER,
  total_cost_usd           REAL,
  step_count               INTEGER,
  tool_count               INTEGER,
  CHECK (trigger IN ('scheduled','manual','replay','on_failure','compile','interactive')),
  CHECK (feedback IS NULL OR feedback IN ('up','down'))
) STRICT;

---- views (1)

-- view run_summary
CREATE VIEW run_summary AS
  SELECT
t.id             AS run_id,
c.kind           AS kind,
CASE WHEN c.kind = 'automation' THEN c.automation_id END AS automation_ref,
CASE
  WHEN c.kind = 'automation' AND instr(c.automation_id, '/') > 1
    THEN substr(c.automation_id, 1, instr(c.automation_id, '/') - 1)
  ELSE c.app_id
END              AS app_id,
-- The automation's display name (issue: orphaned runs showing the raw
-- ref) — conversations.title is refreshed when the stable automation
-- conversation is ensured and outlives the automation manifest being
-- deleted. NULLIF empties it out since the column defaults to ''.
CASE WHEN c.kind = 'automation' THEN NULLIF(c.title, '') END AS automation_name,
t.trigger        AS trigger,
t.trigger_origin AS trigger_origin,
t.ok             AS ok,
t.pinned         AS pinned,
t.summary        AS summary,
t.note           AS note,
t.error          AS error,
t.retry_of       AS retry_of,
(SELECT i.model FROM items i
  WHERE i.turn_id = t.id AND i.model IS NOT NULL AND i.kind IN ('step','delegate')
  GROUP BY i.model
  ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
  LIMIT 1)       AS model,
-- Dominant harness kind for the Insights harness breakdown (issue #514).
(SELECT i.harness FROM items i
  WHERE i.turn_id = t.id AND i.harness IS NOT NULL AND i.kind IN ('step','delegate')
  GROUP BY i.harness
  ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
  LIMIT 1)       AS harness,
-- Effort is recorded only after ACP confirms thought_level. Picking
-- the dominant confirmed value mirrors the model/harness rollups.
(SELECT i.effort FROM items i
  WHERE i.turn_id = t.id AND i.effort IS NOT NULL AND i.kind IN ('step','delegate')
  GROUP BY i.effort
  ORDER BY SUM(COALESCE(i.input_tokens,0)+COALESCE(i.output_tokens,0)) DESC
  LIMIT 1)       AS effort,
t.started_at               AS started_at,
t.ended_at                 AS ended_at,
t.total_input_tokens       AS total_input_tokens,
t.total_output_tokens      AS total_output_tokens,
t.total_cache_read_tokens  AS total_cache_read_tokens,
t.total_cache_write_tokens AS total_cache_write_tokens,
t.hydration_tokens          AS hydration_tokens,
t.total_cost_usd           AS total_cost_usd,
t.step_count               AS step_count,
t.tool_count               AS tool_count
  FROM turns t
  JOIN conversations c ON c.id = t.conversation_id
  WHERE t.ended_at IS NOT NULL;

---- indexes (244)

-- index access_provenance_occurred_page_idx
CREATE INDEX access_provenance_occurred_page_idx
  ON access_provenance(entity_type, entity_id, occurred_at, prov_id);

-- index access_receipt_occurred_page_idx
CREATE INDEX access_receipt_occurred_page_idx
  ON access_receipt(occurred_at, receipt_id);

-- index core_attachment_target_role_page_idx
CREATE INDEX core_attachment_target_role_page_idx
  ON core_attachment(target_type, role, attachment_id);

-- index core_collection_sort_page_idx
CREATE INDEX core_collection_sort_page_idx
  ON core_collection(sort_order, collection_id);

-- index core_concept_key_idx
CREATE UNIQUE INDEX core_concept_key_idx
  ON core_concept(scheme_id, normalized_key) WHERE normalized_key IS NOT NULL;

-- index core_concept_stable_idx
CREATE UNIQUE INDEX core_concept_stable_idx
  ON core_concept(scheme_id, stable_id) WHERE stable_id IS NOT NULL;

-- index core_content_item_purge_idx
CREATE INDEX core_content_item_purge_idx
  ON core_content_item(purge_at) WHERE purge_at IS NOT NULL;

-- index core_document_purge_idx
CREATE INDEX core_document_purge_idx
  ON core_document(purge_at) WHERE purge_at IS NOT NULL;

-- index core_entity_revision_actor_idx
CREATE INDEX core_entity_revision_actor_idx
  ON core_entity_revision(actor_party_id);

-- index core_entity_revision_content_idx
CREATE INDEX core_entity_revision_content_idx
  ON core_entity_revision(content_id) WHERE content_id IS NOT NULL;

-- index core_entity_revision_entity_idx
CREATE INDEX core_entity_revision_entity_idx
  ON core_entity_revision(entity_type, entity_id, recorded_at DESC);

-- index core_entity_revision_invocation_idx
CREATE INDEX core_entity_revision_invocation_idx
  ON core_entity_revision(invocation_id) WHERE invocation_id IS NOT NULL;

-- index core_entity_revision_parent_idx
CREATE INDEX core_entity_revision_parent_idx
  ON core_entity_revision(parent_revision_id) WHERE parent_revision_id IS NOT NULL;

-- index core_entity_revision_recorded_page_idx
CREATE INDEX core_entity_revision_recorded_page_idx
  ON core_entity_revision(entity_type, entity_id, recorded_at, revision_id);

-- index core_entity_revision_undo_idx
CREATE INDEX core_entity_revision_undo_idx
  ON core_entity_revision(undo_until)
  WHERE undone_at IS NULL;

-- index core_event_dtstart_idx
CREATE INDEX core_event_dtstart_idx ON core_event(dtstart);

-- index core_event_dtstart_page_idx
CREATE INDEX core_event_dtstart_page_idx
  ON core_event(dtstart, event_id);

-- index core_link_from_to_page_idx
CREATE INDEX core_link_from_to_page_idx
  ON core_link(from_type, to_type, link_id);

-- index core_link_live_edge_idx
CREATE UNIQUE INDEX core_link_live_edge_idx
  ON core_link(from_type, from_id, to_type, to_id, relation_concept_id)
  WHERE valid_to IS NULL;

-- index core_party_display_name_page_idx
CREATE INDEX core_party_display_name_page_idx
  ON core_party(display_name, party_id);

-- index core_party_identifier_live_idx
CREATE UNIQUE INDEX core_party_identifier_live_idx
  ON core_party_identifier(scheme, COALESCE(issuer, ''), value) WHERE valid_to IS NULL;

-- index core_party_purge_idx
CREATE INDEX core_party_purge_idx
  ON core_party(purge_at) WHERE purge_at IS NOT NULL;

-- index core_place_coords_idx
CREATE INDEX core_place_coords_idx ON core_place(geo_lat, geo_lng);

-- index core_tag_machine_assertion_idx
CREATE UNIQUE INDEX core_tag_machine_assertion_idx
  ON core_tag(target_type, target_id, concept_id, COALESCE(derivation_id, ''))
  WHERE tagged_by_party_id IS NULL;

-- index core_tag_owner_assertion_idx
CREATE UNIQUE INDEX core_tag_owner_assertion_idx
  ON core_tag(target_type, target_id, concept_id)
  WHERE tagged_by_party_id IS NOT NULL;

-- index core_transaction_external_idx
CREATE INDEX core_transaction_external_idx
  ON core_transaction(external_id) WHERE external_id IS NOT NULL;

-- index core_transaction_posted_page_idx
CREATE INDEX core_transaction_posted_page_idx
  ON core_transaction(posted_at, txn_id);

-- index idx_account_institution_party
CREATE INDEX idx_account_institution_party ON core_account(institution_party_id);

-- index idx_account_owner_party
CREATE INDEX idx_account_owner_party ON core_account(owner_party_id);

-- index idx_activity_actor_party
CREATE INDEX idx_activity_actor_party ON core_activity(actor_party_id);

-- index idx_activity_kind_concept
CREATE INDEX idx_activity_kind_concept ON core_activity(kind_concept_id);

-- index idx_activity_location_place
CREATE INDEX idx_activity_location_place ON core_activity(location_place_id);

-- index idx_activity_source_app
CREATE INDEX idx_activity_source_app ON core_activity(source_app_id);

-- index idx_annotation_author_party
CREATE INDEX idx_annotation_author_party ON knowledge_annotation(author_party_id);

-- index idx_annotation_target
CREATE INDEX idx_annotation_target
  ON knowledge_annotation(target_type, target_id);

-- index idx_archive_manifest_prev_manifest
CREATE INDEX idx_archive_manifest_prev_manifest ON audit_archive_manifest(prev_manifest_id);

-- index idx_archive_manifest_stream_time
CREATE INDEX idx_archive_manifest_stream_time ON audit_archive_manifest(stream, to_time);

-- index idx_attachment_content
CREATE INDEX idx_attachment_content ON core_attachment(content_id);

-- index idx_attachment_target
CREATE INDEX idx_attachment_target ON core_attachment(target_type, target_id);

-- index idx_attachments_hash
CREATE INDEX idx_attachments_hash
  ON attachments(hash);

-- index idx_attachments_item
CREATE INDEX idx_attachments_item
  ON attachments(item_id);

-- index idx_attendee_party
CREATE INDEX idx_attendee_party ON schedule_attendee(party_id);

-- index idx_automation_trigger_cursor_updated
CREATE INDEX idx_automation_trigger_cursor_updated
  ON automation_trigger_cursor(updated_at);

-- index idx_blob_access_lru
CREATE INDEX idx_blob_access_lru ON blob_access(last_access_at);

-- index idx_blob_device_content_key_device
CREATE INDEX idx_blob_device_content_key_device
  ON blob_device_content_key(device_id);

-- index idx_blob_ingress_expiry
CREATE INDEX idx_blob_ingress_expiry
  ON blob_ingress_session(state, expires_at);

-- index idx_blob_outbox_retry
CREATE INDEX idx_blob_outbox_retry
  ON blob_outbox(state, next_retry_at, created_at);

-- index idx_blob_staging_derivative_slot
CREATE UNIQUE INDEX idx_blob_staging_derivative_slot
  ON blob_staging(variant_of, variant) WHERE variant IS NOT NULL;

-- index idx_blob_staging_held_by_intent
CREATE INDEX idx_blob_staging_held_by_intent
  ON blob_staging(held_by_intent) WHERE held_by_intent IS NOT NULL;

-- index idx_blob_staging_original_sha
CREATE UNIQUE INDEX idx_blob_staging_original_sha
  ON blob_staging(sha256) WHERE variant IS NULL;

-- index idx_blob_staging_sha
CREATE INDEX idx_blob_staging_sha ON blob_staging(sha256);

-- index idx_calendar_owner_party
CREATE INDEX idx_calendar_owner_party ON schedule_calendar(owner_party_id);

-- index idx_capability_command
CREATE INDEX idx_capability_command ON agent_capability(command_id);

-- index idx_circle_member_party
CREATE INDEX idx_circle_member_party ON social_circle_member(party_id);

-- index idx_collection_cover_content
CREATE INDEX idx_collection_cover_content ON core_collection(cover_content_id);

-- index idx_collection_entry_target
CREATE INDEX idx_collection_entry_target
  ON core_collection_entry(target_type, target_id);

-- index idx_collection_owner_party
CREATE INDEX idx_collection_owner_party ON core_collection(owner_party_id);

-- index idx_collection_parent_collection
CREATE INDEX idx_collection_parent_collection ON core_collection(parent_collection_id);

-- index idx_command_invocation_receipt
CREATE INDEX idx_command_invocation_receipt ON agent_command_invocation(receipt_id);

-- index idx_concept_broader_concept
CREATE INDEX idx_concept_broader_concept ON core_concept(broader_concept_id);

-- index idx_content_derivative_content
CREATE INDEX idx_content_derivative_content ON core_content_derivative(content_id);

-- index idx_content_item_creator_party
CREATE INDEX idx_content_item_creator_party ON core_content_item(creator_party_id);

-- index idx_content_item_origin_device
CREATE INDEX idx_content_item_origin_device ON core_content_item(origin_device_id);

-- index idx_content_representation_content
CREATE INDEX idx_content_representation_content
  ON core_content_representation(content_id);

-- index idx_conversation_archive_conv
CREATE INDEX idx_conversation_archive_conv
  ON conversation_archive(conversation_id, seq_from);

-- index idx_conversation_archive_sha
CREATE INDEX idx_conversation_archive_sha
  ON conversation_archive(segment_sha256);

-- index idx_conversation_archive_unpruned
CREATE INDEX idx_conversation_archive_unpruned
  ON conversation_archive(pruned_at) WHERE pruned_at IS NULL;

-- index idx_conversation_digest_automation
CREATE INDEX idx_conversation_digest_automation
  ON conversation_digest(automation_ref);

-- index idx_conversation_harness_latest
CREATE INDEX idx_conversation_harness_latest
  ON conversation_harness_sessions(conversation_id, harness_kind, status, last_used_at DESC);

-- index idx_conversation_provider_consent_active
CREATE INDEX idx_conversation_provider_consent_active
  ON conversation_provider_consent(conversation_id, harness_kind, subsystem, revoked_at);

-- index idx_conversations_app
CREATE INDEX idx_conversations_app
  ON conversations(app_id, updated_at DESC);

-- index idx_conversations_automation
CREATE INDEX idx_conversations_automation
  ON conversations(automation_id);

-- index idx_conversations_user_updated
CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, pinned DESC, updated_at DESC);

-- index idx_device_owner_party
CREATE INDEX idx_device_owner_party ON access_device(owner_party_id);

-- index idx_document_current_content
CREATE INDEX idx_document_current_content ON core_document(current_content_id);

-- index idx_document_current_revision
CREATE INDEX idx_document_current_revision ON core_document(current_revision_id);

-- index idx_enrich_derivation_model
CREATE INDEX idx_enrich_derivation_model
  ON enrich_derivation(capability, model);

-- index idx_enrich_embedding_entity
CREATE INDEX idx_enrich_embedding_entity
  ON enrich_embedding(target_type, target_id);

-- index idx_enrich_policy_rule_capability
CREATE INDEX idx_enrich_policy_rule_capability
  ON enrich_policy_rule(capability);

-- index idx_enrich_request_capability
CREATE INDEX idx_enrich_request_capability
  ON enrich_request(capability, target_type, requested_at)
  WHERE drained_at IS NULL AND capability IS NOT NULL;

-- index idx_enrich_request_leaseable
CREATE INDEX idx_enrich_request_leaseable
  ON enrich_request(required_capability, lease_expires_at, requested_at)
  WHERE drained_at IS NULL AND required_capability IS NOT NULL;

-- index idx_enrich_request_open
CREATE INDEX idx_enrich_request_open
  ON enrich_request(target_type, requested_at) WHERE drained_at IS NULL;

-- index idx_enrich_request_target
CREATE INDEX idx_enrich_request_target
  ON enrich_request(target_type, target_id);

-- index idx_enrich_target_failure_declined
CREATE INDEX idx_enrich_target_failure_declined
  ON enrich_target_failure(capability, declined);

-- index idx_enrich_target_failure_target
CREATE INDEX idx_enrich_target_failure_target
  ON enrich_target_failure(target_type, target_id);

-- index idx_event_ext_calendar
CREATE INDEX idx_event_ext_calendar ON schedule_event_ext(calendar_id);

-- index idx_event_location_place
CREATE INDEX idx_event_location_place ON core_event(location_place_id);

-- index idx_event_organizer_party
CREATE INDEX idx_event_organizer_party ON core_event(organizer_party_id);

-- index idx_event_purge_at
CREATE INDEX idx_event_purge_at ON core_event(purge_at);

-- index idx_evidence_invocation
CREATE INDEX idx_evidence_invocation ON agent_evidence(invocation_id);

-- index idx_evidence_prov
CREATE INDEX idx_evidence_prov ON agent_evidence(prov_id);

-- index idx_face_region_asset
CREATE INDEX idx_face_region_asset ON media_face_region(asset_id);

-- index idx_face_region_confirmed_by_party
CREATE INDEX idx_face_region_confirmed_by_party ON media_face_region(confirmed_by_party_id);

-- index idx_face_region_party
CREATE INDEX idx_face_region_party ON media_face_region(party_id);

-- index idx_harness_health_breaker
CREATE INDEX idx_harness_health_breaker
  ON harness_health(workspace_context, harness_kind, breaker_until);

-- index idx_important_date_party
CREATE INDEX idx_important_date_party ON people_important_date(party_id);

-- index idx_invocation_check_invocation
CREATE INDEX idx_invocation_check_invocation ON agent_invocation_check(invocation_id);

-- index idx_items_by_model
CREATE INDEX idx_items_by_model
  ON items(model, started_at DESC);

-- index idx_items_by_turn
CREATE INDEX idx_items_by_turn
  ON items(turn_id, ordinal);

-- index idx_items_run_rollup
CREATE INDEX idx_items_run_rollup
  ON items(turn_id, model, harness, effort, input_tokens, output_tokens)
  WHERE kind IN ('step','delegate');

-- index idx_items_turn_call
CREATE UNIQUE INDEX idx_items_turn_call
  ON items(turn_id, call_id) WHERE call_id IS NOT NULL;

-- index idx_link_from
CREATE INDEX idx_link_from ON core_link(from_type, from_id);

-- index idx_link_relation_concept
CREATE INDEX idx_link_relation_concept ON core_link(relation_concept_id);

-- index idx_link_to
CREATE INDEX idx_link_to ON core_link(to_type, to_id);

-- index idx_media_asset_camera_device
CREATE INDEX idx_media_asset_camera_device ON media_asset(camera_device_id);

-- index idx_media_asset_capture_group
CREATE INDEX idx_media_asset_capture_group ON media_asset(capture_group_id);

-- index idx_media_asset_phash_cluster
CREATE INDEX idx_media_asset_phash_cluster
  ON media_asset_phash(cluster_id) WHERE cluster_id IS NOT NULL;

-- index idx_media_asset_place
CREATE INDEX idx_media_asset_place ON media_asset(place_id);

-- index idx_media_asset_source
CREATE INDEX idx_media_asset_source ON media_asset(source_asset_id);

-- index idx_media_face_cluster_cluster
CREATE INDEX idx_media_face_cluster_cluster
  ON media_face_cluster(cluster_id);

-- index idx_media_memory_day_key
CREATE INDEX idx_media_memory_day_key
  ON media_memory(day_key) WHERE day_key IS NOT NULL;

-- index idx_media_memory_kind
CREATE INDEX idx_media_memory_kind ON media_memory(kind);

-- index idx_media_memory_member_asset
CREATE INDEX idx_media_memory_member_asset
  ON media_memory_member(asset_id);

-- index idx_media_memory_place
CREATE INDEX idx_media_memory_place
  ON media_memory(place_id) WHERE place_id IS NOT NULL;

-- index idx_message_body_content
CREATE INDEX idx_message_body_content ON social_message(body_content_id);

-- index idx_message_in_reply_to
CREATE INDEX idx_message_in_reply_to ON social_message(in_reply_to_id);

-- index idx_message_sender_party
CREATE INDEX idx_message_sender_party ON social_message(sender_party_id);

-- index idx_message_thread
CREATE INDEX idx_message_thread ON social_message(thread_id);

-- index idx_message_thread_sent
CREATE INDEX idx_message_thread_sent ON social_message(thread_id, sent_at);

-- index idx_note_author_party
CREATE INDEX idx_note_author_party ON knowledge_note(author_party_id);

-- index idx_note_body_content
CREATE INDEX idx_note_body_content ON knowledge_note(body_content_id);

-- index idx_note_current_revision
CREATE INDEX idx_note_current_revision ON knowledge_note(current_revision_id);

-- index idx_outbox_item_authority
CREATE INDEX idx_outbox_item_authority
  ON outbox_item(authority_id);

-- index idx_outbox_item_connection
CREATE INDEX idx_outbox_item_connection ON outbox_item(connection_id);

-- index idx_outbox_item_published_message
CREATE INDEX idx_outbox_item_published_message ON outbox_item(published_message_id);

-- index idx_outbox_item_recipient_party
CREATE INDEX idx_outbox_item_recipient_party ON outbox_item(recipient_party_id);

-- index idx_outbox_item_status
CREATE INDEX idx_outbox_item_status ON outbox_item(status, staged_at);

-- index idx_outbox_item_target
CREATE INDEX idx_outbox_item_target
  ON outbox_item(target_type, target_id);

-- index idx_party_avatar_content
CREATE INDEX idx_party_avatar_content ON core_party(avatar_content_id);

-- index idx_party_identifier_primary
CREATE UNIQUE INDEX idx_party_identifier_primary
  ON core_party_identifier(party_id, scheme) WHERE is_primary = 1 AND valid_to IS NULL;

-- index idx_place_parent_place
CREATE INDEX idx_place_parent_place ON core_place(parent_place_id);

-- index idx_provenance_entity
CREATE INDEX idx_provenance_entity ON access_provenance(entity_type, entity_id);

-- index idx_provenance_occurred_at
CREATE INDEX idx_provenance_occurred_at ON access_provenance(occurred_at);

-- index idx_provenance_prev_prov
CREATE INDEX idx_provenance_prev_prov ON access_provenance(prev_prov_id);

-- index idx_receipt_authority
CREATE INDEX idx_receipt_authority ON access_receipt(authority_id, occurred_at);

-- index idx_receipt_invocation
CREATE INDEX idx_receipt_invocation ON access_receipt(invocation_id);

-- index idx_receipt_seq
CREATE UNIQUE INDEX idx_receipt_seq ON access_receipt(seq) WHERE seq IS NOT NULL;

-- index idx_replica_intent_device_status
CREATE INDEX idx_replica_intent_device_status
  ON replica_intent_outcome(device_id, status, updated_at);

-- index idx_replica_invocation_commit_intent
CREATE INDEX idx_replica_invocation_commit_intent
  ON replica_invocation_commit(intent_id)
  WHERE intent_id IS NOT NULL;

-- index idx_replica_log_epoch_commit
CREATE INDEX idx_replica_log_epoch_commit
  ON replica_log(epoch, commit_seq, seq);

-- index idx_replica_log_epoch_seq
CREATE INDEX idx_replica_log_epoch_seq
  ON replica_log(epoch, seq);

-- index idx_replica_log_row
CREATE INDEX idx_replica_log_row
  ON replica_log(epoch, "table", pk_json, seq DESC);

-- index idx_replica_parked_grant
CREATE INDEX idx_replica_parked_grant
  ON replica_parked_payload(grant_id, parked_at);

-- index idx_seed_row_app
CREATE INDEX idx_seed_row_app ON access_seed_row(app_id);

-- index idx_sync_connection_run_connection
CREATE INDEX idx_sync_connection_run_connection ON sync_connection_run(connection_id);

-- index idx_sync_external_entity
CREATE INDEX idx_sync_external_entity
  ON sync_external_entity(target_type, target_id);

-- index idx_sync_import_batch_connection
CREATE INDEX idx_sync_import_batch_connection ON sync_import_batch(connection_id);

-- index idx_sync_import_row_batch
CREATE INDEX idx_sync_import_row_batch ON sync_import_row(batch_id, seq);

-- index idx_tag_concept
CREATE INDEX idx_tag_concept ON core_tag(concept_id);

-- index idx_tag_derivation
CREATE INDEX idx_tag_derivation ON core_tag(derivation_id);

-- index idx_tag_input_revision
CREATE INDEX idx_tag_input_revision ON core_tag(input_revision_id);

-- index idx_tag_tagged_by_party
CREATE INDEX idx_tag_tagged_by_party ON core_tag(tagged_by_party_id);

-- index idx_task_owner_party
CREATE INDEX idx_task_owner_party ON schedule_task(owner_party_id);

-- index idx_task_parent_task
CREATE INDEX idx_task_parent_task ON schedule_task(parent_task_id);

-- index idx_task_purge_at
CREATE INDEX idx_task_purge_at ON schedule_task(purge_at);

-- index idx_thread_participant_party
CREATE INDEX idx_thread_participant_party ON social_thread_participant(party_id);

-- index idx_transaction_account
CREATE INDEX idx_transaction_account ON core_transaction(account_id);

-- index idx_transaction_category_concept
CREATE INDEX idx_transaction_category_concept ON core_transaction(category_concept_id);

-- index idx_transaction_counterparty_party
CREATE INDEX idx_transaction_counterparty_party ON core_transaction(counterparty_party_id);

-- index idx_trigger_ingress_expiry
CREATE INDEX idx_trigger_ingress_expiry
  ON trigger_ingress(expires_at);

-- index idx_trigger_ingress_source_position
CREATE INDEX idx_trigger_ingress_source_position
  ON trigger_ingress(source_key, id);

-- index idx_turns_conversation
CREATE INDEX idx_turns_conversation
  ON turns(conversation_id, seq);

-- index idx_turns_idempotency
CREATE INDEX idx_turns_idempotency
  ON turns(conversation_id, idempotency_key);

-- index idx_turns_parent
CREATE INDEX idx_turns_parent
  ON turns(parent_turn_id);

-- index idx_turns_started
CREATE INDEX idx_turns_started
  ON turns(started_at DESC);

-- index idx_vault_self_party
CREATE INDEX idx_vault_self_party ON core_vault(self_party_id);

-- index knowledge_note_deleted_page_idx
CREATE INDEX knowledge_note_deleted_page_idx
  ON knowledge_note(deleted_at, note_id);

-- index knowledge_note_purge_idx
CREATE INDEX knowledge_note_purge_idx
  ON knowledge_note(purge_at) WHERE purge_at IS NOT NULL;

-- index knowledge_note_updated_page_idx
CREATE INDEX knowledge_note_updated_page_idx
  ON knowledge_note(deleted_at, updated_at, note_id);

-- index locker_item_address_item_idx
CREATE INDEX locker_item_address_item_idx
  ON locker_item_address(item_id, position);

-- index locker_item_alias_item_idx
CREATE INDEX locker_item_alias_item_idx ON locker_item_alias(item_id);

-- index locker_item_archived_idx
CREATE INDEX locker_item_archived_idx ON locker_item(archived_at);

-- index locker_item_connection_idx
CREATE INDEX locker_item_connection_idx ON locker_item(connection_id);

-- index locker_item_field_item_idx
CREATE INDEX locker_item_field_item_idx
  ON locker_item_field(item_id, section, position);

-- index locker_item_passkey_rp_idx
CREATE INDEX locker_item_passkey_rp_idx ON locker_item_passkey(rp_id);

-- index locker_item_purge_idx
CREATE INDEX locker_item_purge_idx
  ON locker_item(purge_at) WHERE purge_at IS NOT NULL;

-- index locker_item_type_idx
CREATE INDEX locker_item_type_idx ON locker_item(type);

-- index locker_item_type_updated_page_idx
CREATE INDEX locker_item_type_updated_page_idx
  ON locker_item(type, deleted_at, updated_at, item_id);

-- index locker_item_updated_page_idx
CREATE INDEX locker_item_updated_page_idx
  ON locker_item(updated_at, item_id);

-- index locker_key_live_idx
CREATE UNIQUE INDEX locker_key_live_idx
  ON locker_key(retired_at IS NULL) WHERE retired_at IS NULL;

-- index media_asset_captured_page_idx
CREATE INDEX media_asset_captured_page_idx
  ON media_asset(deleted_at, archived_at, captured_at, asset_id);

-- index media_asset_deleted_page_idx
CREATE INDEX media_asset_deleted_page_idx
  ON media_asset(deleted_at, asset_id);

-- index media_asset_phash_cluster_page_idx
CREATE INDEX media_asset_phash_cluster_page_idx
  ON media_asset_phash(cluster_id, asset_id);

-- index media_asset_purge_idx
CREATE INDEX media_asset_purge_idx
  ON media_asset(purge_at) WHERE purge_at IS NOT NULL;

-- index media_face_region_asset_page_idx
CREATE INDEX media_face_region_asset_page_idx
  ON media_face_region(asset_id, region_id);

-- index notifications_notice_active_idx
CREATE INDEX notifications_notice_active_idx
  ON notifications_notice(archived_at, last_at DESC);

-- index notifications_notice_retention_idx
CREATE INDEX notifications_notice_retention_idx
  ON notifications_notice(last_at);

-- index people_important_date_purge_idx
CREATE INDEX people_important_date_purge_idx
  ON people_important_date(purge_at) WHERE purge_at IS NOT NULL;

-- index people_profile_created_page_idx
CREATE INDEX people_profile_created_page_idx
  ON people_profile(deleted_at, created_at, party_id);

-- index people_profile_deleted_page_idx
CREATE INDEX people_profile_deleted_page_idx
  ON people_profile(deleted_at, party_id);

-- index people_profile_purge_idx
CREATE INDEX people_profile_purge_idx ON people_profile(purge_at);

-- index schedule_project_owner_idx
CREATE INDEX schedule_project_owner_idx
  ON schedule_project(owner_party_id, archived_at, sort_order);

-- index schedule_project_sort_page_idx
CREATE INDEX schedule_project_sort_page_idx
  ON schedule_project(sort_order, project_id);

-- index schedule_recurrence_exception_attendee_party_idx
CREATE INDEX schedule_recurrence_exception_attendee_party_idx
  ON schedule_recurrence_exception_attendee(party_id);

-- index schedule_recurrence_exception_target_idx
CREATE INDEX schedule_recurrence_exception_target_idx
  ON schedule_recurrence_exception(target_type, target_id, original_start_local);

-- index schedule_recurrence_exception_target_page_idx
CREATE INDEX schedule_recurrence_exception_target_page_idx
  ON schedule_recurrence_exception(target_type, exception_id);

-- index schedule_section_project_idx
CREATE INDEX schedule_section_project_idx
  ON schedule_section(project_id, sort_order);

-- index schedule_section_sort_page_idx
CREATE INDEX schedule_section_sort_page_idx
  ON schedule_section(sort_order, section_id);

-- index schedule_task_completed_page_idx
CREATE INDEX schedule_task_completed_page_idx
  ON schedule_task(completed_at, task_id);

-- index schedule_task_created_page_idx
CREATE INDEX schedule_task_created_page_idx
  ON schedule_task(created_at, task_id);

-- index schedule_task_due_at_idx
CREATE INDEX schedule_task_due_at_idx ON schedule_task(due_at) WHERE due_at IS NOT NULL;

-- index schedule_task_due_page_idx
CREATE INDEX schedule_task_due_page_idx
  ON schedule_task(due_at, task_id);

-- index schedule_task_organize_idx
CREATE INDEX schedule_task_organize_idx
  ON schedule_task(project_id, section_id, sort_order);

-- index schedule_task_section_idx
CREATE INDEX schedule_task_section_idx
  ON schedule_task(section_id);

-- index schedule_task_series_idx
CREATE INDEX schedule_task_series_idx
  ON schedule_task(series_id, due_at) WHERE series_id IS NOT NULL;

-- index share_authority_granted_by
CREATE INDEX share_authority_granted_by
  ON share_authority(granted_by);

-- index share_authority_live_answer
CREATE UNIQUE INDEX share_authority_live_answer
  ON share_authority(principal_kind, principal_id, subject_type, subject_id,
                     verb)
  WHERE revoked_at IS NULL;

-- index share_authority_principal
CREATE INDEX share_authority_principal
  ON share_authority(principal_kind, principal_id);

-- index share_authority_request_open
CREATE UNIQUE INDEX share_authority_request_open
  ON share_authority_request(principal_id) WHERE decided_at IS NULL;

-- index share_authority_subject
CREATE INDEX share_authority_subject
  ON share_authority(subject_type, subject_id) WHERE revoked_at IS NULL;

-- index share_party_vault_binding_live_party
CREATE UNIQUE INDEX share_party_vault_binding_live_party
  ON share_party_vault_binding(party_id) WHERE revoked_at IS NULL;

-- index share_subscription_lineage_target
CREATE INDEX share_subscription_lineage_target
  ON share_subscription_lineage(target_type, target_id);

-- index share_subscription_subscribed_page_idx
CREATE INDEX share_subscription_subscribed_page_idx
  ON share_subscription(subscribed_at, authority_id);

-- index social_contact_channel_duplicate_idx
CREATE INDEX social_contact_channel_duplicate_idx
  ON social_contact_channel(kind, normalized_value, party_id);

-- index social_contact_channel_party_idx
CREATE INDEX social_contact_channel_party_idx
  ON social_contact_channel(party_id, kind, is_preferred DESC);

-- index social_contact_channel_preferred_idx
CREATE UNIQUE INDEX social_contact_channel_preferred_idx
  ON social_contact_channel(party_id, kind) WHERE is_preferred = 1;

-- index tally_expense_deleted_page_idx
CREATE INDEX tally_expense_deleted_page_idx
  ON tally_expense(deleted_at, expense_id);

-- index tally_expense_group_idx
CREATE INDEX tally_expense_group_idx ON tally_expense(group_id);

-- index tally_expense_line_allocation_party_idx
CREATE INDEX tally_expense_line_allocation_party_idx
  ON tally_expense_line_allocation(party_id);

-- index tally_expense_line_expense_idx
CREATE INDEX tally_expense_line_expense_idx
  ON tally_expense_line_item(expense_id, sort_order);

-- index tally_expense_line_receipt_idx
CREATE INDEX tally_expense_line_receipt_idx
  ON tally_expense_line_item(receipt_id, sort_order);

-- index tally_expense_paid_by_idx
CREATE INDEX tally_expense_paid_by_idx ON tally_expense(paid_by);

-- index tally_expense_payer_party_idx
CREATE INDEX tally_expense_payer_party_idx ON tally_expense_payer(party_id);

-- index tally_expense_purge_idx
CREATE INDEX tally_expense_purge_idx
  ON tally_expense(purge_at) WHERE purge_at IS NOT NULL;

-- index tally_expense_recurring_instance_idx
CREATE UNIQUE INDEX tally_expense_recurring_instance_idx
  ON tally_expense(recurring_template_id, spent_on)
  WHERE recurring_template_id IS NOT NULL;

-- index tally_expense_spent_page_idx
CREATE INDEX tally_expense_spent_page_idx
  ON tally_expense(deleted_at, spent_on, expense_id);

-- index tally_expense_split_party_idx
CREATE INDEX tally_expense_split_party_idx ON tally_expense_split(party_id);

-- index tally_expense_txn_idx
CREATE INDEX tally_expense_txn_idx ON tally_expense(txn_id);

-- index tally_group_archived_idx
CREATE INDEX tally_group_archived_idx ON tally_group(archived_at);

-- index tally_nudge_group_idx
CREATE INDEX tally_nudge_group_idx ON tally_nudge(group_id);

-- index tally_nudge_party_idx
CREATE INDEX tally_nudge_party_idx ON tally_nudge(party_id, prepared_at DESC);

-- index tally_nudge_prepared_page_idx
CREATE INDEX tally_nudge_prepared_page_idx
  ON tally_nudge(prepared_at, nudge_id);

-- index tally_obligation_from_party_idx
CREATE INDEX tally_obligation_from_party_idx ON tally_obligation(from_party);

-- index tally_obligation_purge_idx
CREATE INDEX tally_obligation_purge_idx
  ON tally_obligation(purge_at) WHERE purge_at IS NOT NULL;

-- index tally_obligation_to_party_idx
CREATE INDEX tally_obligation_to_party_idx ON tally_obligation(to_party);

-- index tally_recurring_expense_group_idx
CREATE INDEX tally_recurring_expense_group_idx
  ON tally_recurring_expense(group_id, status, anchor_start);

-- index tally_recurring_expense_paid_by_idx
CREATE INDEX tally_recurring_expense_paid_by_idx
  ON tally_recurring_expense(paid_by);

-- index tally_recurring_expense_split_party_idx
CREATE INDEX tally_recurring_expense_split_party_idx
  ON tally_recurring_expense_split(party_id);

-- index tally_recurring_expense_updated_page_idx
CREATE INDEX tally_recurring_expense_updated_page_idx
  ON tally_recurring_expense(updated_at, template_id);

-- index tally_settlement_from_party_idx
CREATE INDEX tally_settlement_from_party_idx ON tally_settlement(from_party);

-- index tally_settlement_group_idx
CREATE INDEX tally_settlement_group_idx ON tally_settlement(group_id);

-- index tally_settlement_purge_idx
CREATE INDEX tally_settlement_purge_idx
  ON tally_settlement(purge_at) WHERE purge_at IS NOT NULL;

-- index tally_settlement_to_party_idx
CREATE INDEX tally_settlement_to_party_idx ON tally_settlement(to_party);

-- index tally_settlement_txn_idx
CREATE INDEX tally_settlement_txn_idx ON tally_settlement(txn_id);

---- triggers (268)

-- trigger access_app_ext_touch_updated_at
CREATE TRIGGER access_app_ext_touch_updated_at
AFTER UPDATE ON access_app_ext
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE access_app_ext
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE app_id = NEW.app_id AND band = NEW.band AND table_name = NEW.table_name;
END;

-- trigger access_provenance_append_only_d
CREATE TRIGGER access_provenance_append_only_d
BEFORE DELETE ON access_provenance
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_provenance is append-only: rows leave only through the archive pass');
END;

-- trigger access_provenance_append_only_u
CREATE TRIGGER access_provenance_append_only_u
BEFORE UPDATE ON access_provenance
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_provenance is append-only: an audit row is never rewritten');
END;

-- trigger access_receipt_append_only_d
CREATE TRIGGER access_receipt_append_only_d
BEFORE DELETE ON access_receipt
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_receipt is append-only: rows leave only through the archive pass');
END;

-- trigger access_receipt_append_only_u
CREATE TRIGGER access_receipt_append_only_u
BEFORE UPDATE ON access_receipt
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'access_receipt is append-only: an audit row is never rewritten');
END;

-- trigger agent_command_invocation_append_only_d
CREATE TRIGGER agent_command_invocation_append_only_d
BEFORE DELETE ON agent_command_invocation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_command_invocation is append-only: rows leave only through the archive pass');
END;

-- trigger agent_command_invocation_append_only_u
CREATE TRIGGER agent_command_invocation_append_only_u
BEFORE UPDATE OF invocation_id, command_id, caller_id, authority_id, input_json,
                 requested_at
ON agent_command_invocation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_command_invocation is append-only in what was asked: only status, executed_at and receipt_id settle');
END;

-- trigger agent_evidence_append_only_d
CREATE TRIGGER agent_evidence_append_only_d
BEFORE DELETE ON agent_evidence
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_evidence is append-only: rows leave only through the archive pass');
END;

-- trigger agent_evidence_append_only_u
CREATE TRIGGER agent_evidence_append_only_u
BEFORE UPDATE ON agent_evidence
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_evidence is append-only: an audit row is never rewritten');
END;

-- trigger agent_explanation_append_only_d
CREATE TRIGGER agent_explanation_append_only_d
BEFORE DELETE ON agent_explanation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_explanation is append-only: rows leave only through the archive pass');
END;

-- trigger agent_explanation_append_only_u
CREATE TRIGGER agent_explanation_append_only_u
BEFORE UPDATE ON agent_explanation
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_explanation is append-only: an audit row is never rewritten');
END;

-- trigger agent_invocation_check_append_only_d
CREATE TRIGGER agent_invocation_check_append_only_d
BEFORE DELETE ON agent_invocation_check
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_invocation_check is append-only: rows leave only through the archive pass');
END;

-- trigger agent_invocation_check_append_only_u
CREATE TRIGGER agent_invocation_check_append_only_u
BEFORE UPDATE ON agent_invocation_check
WHEN NOT EXISTS (SELECT 1 FROM audit_archive_pass)
BEGIN
  SELECT RAISE(ABORT, 'agent_invocation_check is append-only: an audit row is never rewritten');
END;

-- trigger blob_content_key_touch_updated_at
CREATE TRIGGER blob_content_key_touch_updated_at
AFTER UPDATE ON blob_content_key
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE blob_content_key
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE sha256 = NEW.sha256;
END;

-- trigger blob_device_wrap_key_touch_updated_at
CREATE TRIGGER blob_device_wrap_key_touch_updated_at
AFTER UPDATE ON blob_device_wrap_key
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE blob_device_wrap_key
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE device_id = NEW.device_id;
END;

-- trigger blob_ingress_session_touch_updated_at
CREATE TRIGGER blob_ingress_session_touch_updated_at
AFTER UPDATE ON blob_ingress_session
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE blob_ingress_session
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE session_id = NEW.session_id;
END;

-- trigger blob_outbox_touch_updated_at
CREATE TRIGGER blob_outbox_touch_updated_at
AFTER UPDATE ON blob_outbox
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE blob_outbox
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE sha256 = NEW.sha256;
END;

-- trigger conversation_item_count_ad
CREATE TRIGGER conversation_item_count_ad
  AFTER DELETE ON items BEGIN
  UPDATE conversations
     SET item_count = MAX(item_count - 1, 0)
   WHERE id = (SELECT conversation_id FROM turns WHERE id = old.turn_id);
END;

-- trigger conversation_item_count_ai
CREATE TRIGGER conversation_item_count_ai
  AFTER INSERT ON items BEGIN
  UPDATE conversations
     SET item_count = item_count + 1
   WHERE id = (SELECT conversation_id FROM turns WHERE id = new.turn_id);
END;

-- trigger core_account_entity_delete
CREATE TRIGGER core_account_entity_delete
AFTER DELETE ON core_account
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.account_id;
END;

-- trigger core_account_entity_insert
CREATE TRIGGER core_account_entity_insert
BEFORE INSERT ON core_account
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_account (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.account_id AND entity_type <> 'core.account');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.account_id, 'core.account', COALESCE(NEW.opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_activity_entity_delete
CREATE TRIGGER core_activity_entity_delete
AFTER DELETE ON core_activity
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.activity_id;
END;

-- trigger core_activity_entity_insert
CREATE TRIGGER core_activity_entity_insert
BEFORE INSERT ON core_activity
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_activity (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.activity_id AND entity_type <> 'core.activity');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.activity_id, 'core.activity', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_attachment_entity_delete
CREATE TRIGGER core_attachment_entity_delete
AFTER DELETE ON core_attachment
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.attachment_id;
END;

-- trigger core_attachment_entity_insert
CREATE TRIGGER core_attachment_entity_insert
BEFORE INSERT ON core_attachment
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_attachment (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.attachment_id AND entity_type <> 'core.attachment');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.attachment_id, 'core.attachment', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_collection_entity_delete
CREATE TRIGGER core_collection_entity_delete
AFTER DELETE ON core_collection
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.collection_id;
END;

-- trigger core_collection_entity_insert
CREATE TRIGGER core_collection_entity_insert
BEFORE INSERT ON core_collection
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_collection (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.collection_id AND entity_type <> 'core.collection');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.collection_id, 'core.collection', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_collection_entry_entity_delete
CREATE TRIGGER core_collection_entry_entity_delete
AFTER DELETE ON core_collection_entry
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.entry_id;
END;

-- trigger core_collection_entry_entity_insert
CREATE TRIGGER core_collection_entry_entity_insert
BEFORE INSERT ON core_collection_entry
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_collection_entry (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.entry_id AND entity_type <> 'core.collection_entry');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.entry_id, 'core.collection_entry', COALESCE(NEW.added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_collection_touch_updated_at
CREATE TRIGGER core_collection_touch_updated_at
AFTER UPDATE ON core_collection
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_collection
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE collection_id = NEW.collection_id;
END;

-- trigger core_concept_entity_delete
CREATE TRIGGER core_concept_entity_delete
AFTER DELETE ON core_concept
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.concept_id;
END;

-- trigger core_concept_entity_insert
CREATE TRIGGER core_concept_entity_insert
BEFORE INSERT ON core_concept
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_concept (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.concept_id AND entity_type <> 'core.concept');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.concept_id, 'core.concept', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_concept_scheme_entity_delete
CREATE TRIGGER core_concept_scheme_entity_delete
AFTER DELETE ON core_concept_scheme
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.scheme_id;
END;

-- trigger core_concept_scheme_entity_insert
CREATE TRIGGER core_concept_scheme_entity_insert
BEFORE INSERT ON core_concept_scheme
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_concept_scheme (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.scheme_id AND entity_type <> 'core.concept_scheme');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.scheme_id, 'core.concept_scheme', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_concept_touch_updated_at
CREATE TRIGGER core_concept_touch_updated_at
AFTER UPDATE ON core_concept
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_concept
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE concept_id = NEW.concept_id;
END;

-- trigger core_content_derivative_entity_delete
CREATE TRIGGER core_content_derivative_entity_delete
AFTER DELETE ON core_content_derivative
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.derivative_id;
END;

-- trigger core_content_derivative_entity_insert
CREATE TRIGGER core_content_derivative_entity_insert
BEFORE INSERT ON core_content_derivative
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_content_derivative (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.derivative_id AND entity_type <> 'core.content_derivative');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.derivative_id, 'core.content_derivative', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_content_derivative_touch_updated_at
CREATE TRIGGER core_content_derivative_touch_updated_at
AFTER UPDATE ON core_content_derivative
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_content_derivative
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE derivative_id = NEW.derivative_id;
END;

-- trigger core_content_item_entity_delete
CREATE TRIGGER core_content_item_entity_delete
AFTER DELETE ON core_content_item
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.content_id;
END;

-- trigger core_content_item_entity_insert
CREATE TRIGGER core_content_item_entity_insert
BEFORE INSERT ON core_content_item
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_content_item (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.content_id AND entity_type <> 'core.content_item');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.content_id, 'core.content_item', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_content_item_hash_follows_bytes
CREATE TRIGGER core_content_item_hash_follows_bytes
BEFORE UPDATE OF sha256 ON core_content_item
WHEN NEW.sha256 <> OLD.sha256
 AND NEW.content_uri = OLD.content_uri
 AND NEW.byte_size = OLD.byte_size
BEGIN
  SELECT RAISE(ABORT, 'core.content_item: the hash of a content item is the identity of its bytes — it cannot change while the bytes stay where they are (issue #996, ruling R21)');
END;

-- trigger core_content_item_touch_updated_at
CREATE TRIGGER core_content_item_touch_updated_at
AFTER UPDATE ON core_content_item
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_content_item
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE content_id = NEW.content_id;
END;

-- trigger core_content_representation_entity_delete
CREATE TRIGGER core_content_representation_entity_delete
AFTER DELETE ON core_content_representation
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.representation_id;
END;

-- trigger core_content_representation_entity_insert
CREATE TRIGGER core_content_representation_entity_insert
BEFORE INSERT ON core_content_representation
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_content_representation (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.representation_id AND entity_type <> 'core.content_representation');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.representation_id, 'core.content_representation', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_content_representation_touch_updated_at
CREATE TRIGGER core_content_representation_touch_updated_at
AFTER UPDATE ON core_content_representation
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_content_representation
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE representation_id = NEW.representation_id;
END;

-- trigger core_content_text_touch_updated_at
CREATE TRIGGER core_content_text_touch_updated_at
AFTER UPDATE ON core_content_text
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_content_text
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE content_id = NEW.content_id;
END;

-- trigger core_document_entity_delete
CREATE TRIGGER core_document_entity_delete
AFTER DELETE ON core_document
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.document_id;
END;

-- trigger core_document_entity_insert
CREATE TRIGGER core_document_entity_insert
BEFORE INSERT ON core_document
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_document (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.document_id AND entity_type <> 'core.document');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.document_id, 'core.document', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_document_touch_updated_at
CREATE TRIGGER core_document_touch_updated_at
AFTER UPDATE ON core_document
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_document
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE document_id = NEW.document_id;
END;

-- trigger core_entity_revision_entity_delete
CREATE TRIGGER core_entity_revision_entity_delete
AFTER DELETE ON core_entity_revision
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.revision_id;
END;

-- trigger core_entity_revision_entity_insert
CREATE TRIGGER core_entity_revision_entity_insert
BEFORE INSERT ON core_entity_revision
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_entity_revision (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.revision_id AND entity_type <> 'core.entity_revision');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.revision_id, 'core.entity_revision', COALESCE(NEW.recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_entity_revision_touch_updated_at
CREATE TRIGGER core_entity_revision_touch_updated_at
AFTER UPDATE ON core_entity_revision
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_entity_revision
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE revision_id = NEW.revision_id;
END;

-- trigger core_entity_revoke_on_purge
CREATE TRIGGER core_entity_revoke_on_purge
BEFORE DELETE ON core_entity
BEGIN
  UPDATE share_authority
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_reason = 'subject-purged'
   WHERE subject_type = OLD.entity_type
     AND subject_id = OLD.entity_id
     AND revoked_at IS NULL;
  -- The PRINCIPAL side of the same rule (#916, D1). `principal_id` is
  -- polymorphic on `principal_kind` and carries no foreign key, so a purged
  -- principal would leave live answers naming a row that is not there — a share
  -- the member granted that can no longer be resolved to a peer vault, failing
  -- silently. See schema/party-pointers.ts.
  --
  -- EVERY principal kind that is a ROW, not just 'person' (#916, audit F3):
  -- the clause is generated from `PRINCIPAL_ENTITY_KINDS`, so a circle
  -- deleted by `tally.delete_group` or by share/removal.ts ends the answers
  -- its members hold through it, and a fifth kind cannot be added to the
  -- table's CHECK without landing here too.
  UPDATE share_authority
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_reason = 'principal-purged'
   WHERE principal_id = OLD.entity_id
     AND revoked_at IS NULL
     AND principal_kind = CASE OLD.entity_type
           WHEN 'core.party' THEN 'person'
           WHEN 'social.circle' THEN 'circle'
         END;
END;

-- trigger core_event_entity_delete
CREATE TRIGGER core_event_entity_delete
AFTER DELETE ON core_event
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.event_id;
END;

-- trigger core_event_entity_insert
CREATE TRIGGER core_event_entity_insert
BEFORE INSERT ON core_event
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_event (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.event_id AND entity_type <> 'core.event');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.event_id, 'core.event', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_event_touch_updated_at
CREATE TRIGGER core_event_touch_updated_at
AFTER UPDATE ON core_event
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_event
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE event_id = NEW.event_id;
END;

-- trigger core_link_anchor_entity_delete
CREATE TRIGGER core_link_anchor_entity_delete
AFTER DELETE ON core_link_anchor
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.anchor_id;
END;

-- trigger core_link_anchor_entity_insert
CREATE TRIGGER core_link_anchor_entity_insert
BEFORE INSERT ON core_link_anchor
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_link_anchor (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.anchor_id AND entity_type <> 'core.link_anchor');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.anchor_id, 'core.link_anchor', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_link_anchor_touch_updated_at
CREATE TRIGGER core_link_anchor_touch_updated_at
AFTER UPDATE ON core_link_anchor
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_link_anchor
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE anchor_id = NEW.anchor_id;
END;

-- trigger core_link_entity_delete
CREATE TRIGGER core_link_entity_delete
AFTER DELETE ON core_link
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.link_id;
END;

-- trigger core_link_entity_insert
CREATE TRIGGER core_link_entity_insert
BEFORE INSERT ON core_link
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_link (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.link_id AND entity_type <> 'core.link');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.link_id, 'core.link', COALESCE(NEW.valid_from, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_link_touch_updated_at
CREATE TRIGGER core_link_touch_updated_at
AFTER UPDATE ON core_link
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_link
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE link_id = NEW.link_id;
END;

-- trigger core_party_entity_delete
CREATE TRIGGER core_party_entity_delete
AFTER DELETE ON core_party
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.party_id;
END;

-- trigger core_party_entity_insert
CREATE TRIGGER core_party_entity_insert
BEFORE INSERT ON core_party
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_party (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.party_id AND entity_type <> 'core.party');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.party_id, 'core.party', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_party_identifier_entity_delete
CREATE TRIGGER core_party_identifier_entity_delete
AFTER DELETE ON core_party_identifier
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.identifier_id;
END;

-- trigger core_party_identifier_entity_insert
CREATE TRIGGER core_party_identifier_entity_insert
BEFORE INSERT ON core_party_identifier
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_party_identifier (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.identifier_id AND entity_type <> 'core.party_identifier');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.identifier_id, 'core.party_identifier', COALESCE(NEW.valid_from, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_party_identifier_touch_updated_at
CREATE TRIGGER core_party_identifier_touch_updated_at
AFTER UPDATE ON core_party_identifier
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_party_identifier
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE identifier_id = NEW.identifier_id;
END;

-- trigger core_party_touch_updated_at
CREATE TRIGGER core_party_touch_updated_at
AFTER UPDATE ON core_party
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_party
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE party_id = NEW.party_id;
END;

-- trigger core_place_entity_delete
CREATE TRIGGER core_place_entity_delete
AFTER DELETE ON core_place
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.place_id;
END;

-- trigger core_place_entity_insert
CREATE TRIGGER core_place_entity_insert
BEFORE INSERT ON core_place
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_place (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.place_id AND entity_type <> 'core.place');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.place_id, 'core.place', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_place_touch_updated_at
CREATE TRIGGER core_place_touch_updated_at
AFTER UPDATE ON core_place
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_place
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE place_id = NEW.place_id;
END;

-- trigger core_tag_entity_delete
CREATE TRIGGER core_tag_entity_delete
AFTER DELETE ON core_tag
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.tag_id;
END;

-- trigger core_tag_entity_insert
CREATE TRIGGER core_tag_entity_insert
BEFORE INSERT ON core_tag
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_tag (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.tag_id AND entity_type <> 'core.tag');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.tag_id, 'core.tag', COALESCE(NEW.tagged_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_tag_touch_updated_at
CREATE TRIGGER core_tag_touch_updated_at
AFTER UPDATE ON core_tag
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_tag
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE tag_id = NEW.tag_id;
END;

-- trigger core_transaction_entity_delete
CREATE TRIGGER core_transaction_entity_delete
AFTER DELETE ON core_transaction
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.txn_id;
END;

-- trigger core_transaction_entity_insert
CREATE TRIGGER core_transaction_entity_insert
BEFORE INSERT ON core_transaction
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_transaction (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.txn_id AND entity_type <> 'core.transaction');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.txn_id, 'core.transaction', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_transaction_touch_updated_at
CREATE TRIGGER core_transaction_touch_updated_at
AFTER UPDATE ON core_transaction
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_transaction
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE txn_id = NEW.txn_id;
END;

-- trigger core_vault_entity_delete
CREATE TRIGGER core_vault_entity_delete
AFTER DELETE ON core_vault
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.vault_id;
END;

-- trigger core_vault_entity_insert
CREATE TRIGGER core_vault_entity_insert
BEFORE INSERT ON core_vault
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_vault (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.vault_id AND entity_type <> 'core.vault');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.vault_id, 'core.vault', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_vault_touch_updated_at
CREATE TRIGGER core_vault_touch_updated_at
AFTER UPDATE ON core_vault
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_vault
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE vault_id = NEW.vault_id;
END;

-- trigger enrich_policy_rule_touch_updated_at
CREATE TRIGGER enrich_policy_rule_touch_updated_at
AFTER UPDATE ON enrich_policy_rule
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE enrich_policy_rule
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE rule_id = NEW.rule_id;
END;

-- trigger enrich_policy_touch_updated_at
CREATE TRIGGER enrich_policy_touch_updated_at
AFTER UPDATE ON enrich_policy
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE enrich_policy
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE domain = NEW.domain;
END;

-- trigger fts_conversation_conv_ad
CREATE TRIGGER fts_conversation_conv_ad
  AFTER DELETE ON conversations BEGIN
  DELETE FROM fts_conversation WHERE conversation_id = old.id;
END;

-- trigger fts_conversation_conv_ai
CREATE TRIGGER fts_conversation_conv_ai
  AFTER INSERT ON conversations WHEN new.kind IN ('chat','build') BEGIN
  INSERT INTO fts_conversation(conversation_id, title, body)
    VALUES (new.id, new.title, '');
END;

-- trigger fts_conversation_conv_au
CREATE TRIGGER fts_conversation_conv_au
  AFTER UPDATE OF title ON conversations WHEN new.kind IN ('chat','build') BEGIN
  DELETE FROM fts_conversation WHERE conversation_id = old.id;
  INSERT INTO fts_conversation(conversation_id, title, body)
    SELECT new.id, new.title,
      (SELECT COALESCE(group_concat(i.text, ' '), '')
         FROM items i JOIN turns t ON t.id = i.turn_id
        WHERE t.conversation_id = new.id AND i.text IS NOT NULL AND i.text <> '');
END;

-- trigger fts_conversation_item_ad
CREATE TRIGGER fts_conversation_item_ad
  AFTER DELETE ON items WHEN old.text IS NOT NULL AND old.text <> '' BEGIN
  UPDATE fts_conversation
     SET body = (SELECT COALESCE(group_concat(i.text, ' '), '')
                   FROM items i JOIN turns t ON t.id = i.turn_id
                  WHERE t.conversation_id = fts_conversation.conversation_id
                    AND i.text IS NOT NULL AND i.text <> '')
   WHERE conversation_id = (SELECT conversation_id FROM turns WHERE id = old.turn_id);
END;

-- trigger fts_conversation_item_ai
CREATE TRIGGER fts_conversation_item_ai
  AFTER INSERT ON items WHEN new.text IS NOT NULL AND new.text <> '' BEGIN
  UPDATE fts_conversation
     SET body = CASE WHEN body = '' THEN new.text ELSE body || ' ' || new.text END
   WHERE conversation_id = (SELECT conversation_id FROM turns WHERE id = new.turn_id);
END;

-- trigger fts_conversation_turn_ad
CREATE TRIGGER fts_conversation_turn_ad
  AFTER DELETE ON turns BEGIN
  UPDATE fts_conversation
     SET body = (SELECT COALESCE(group_concat(i.text, ' '), '')
                   FROM items i JOIN turns t ON t.id = i.turn_id
                  WHERE t.conversation_id = fts_conversation.conversation_id
                    AND i.text IS NOT NULL AND i.text <> '')
   WHERE conversation_id = old.conversation_id;
END;

-- trigger fts_core_collection_ad
CREATE TRIGGER fts_core_collection_ad AFTER DELETE ON core_collection BEGIN
  DELETE FROM fts_core_collection WHERE rowid = old.rowid;
END;

-- trigger fts_core_collection_ai
CREATE TRIGGER fts_core_collection_ai AFTER INSERT ON core_collection BEGIN
  INSERT INTO fts_core_collection(rowid, collection_id, name) SELECT new.rowid, new."collection_id", new."name";
END;

-- trigger fts_core_collection_au
CREATE TRIGGER fts_core_collection_au AFTER UPDATE ON core_collection BEGIN
  DELETE FROM fts_core_collection WHERE rowid = old.rowid;
  INSERT INTO fts_core_collection(rowid, collection_id, name) SELECT new.rowid, new."collection_id", new."name";
END;

-- trigger fts_core_content_item_ad
CREATE TRIGGER fts_core_content_item_ad AFTER DELETE ON core_content_item BEGIN
  DELETE FROM fts_core_content_item WHERE rowid = old.rowid;
END;

-- trigger fts_core_content_item_ai
CREATE TRIGGER fts_core_content_item_ai AFTER INSERT ON core_content_item BEGIN
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')) END)
   WHERE new.deleted_at IS NULL;
END;

-- trigger fts_core_content_item_au
CREATE TRIGGER fts_core_content_item_au AFTER UPDATE ON core_content_item BEGIN
  DELETE FROM fts_core_content_item WHERE rowid = old.rowid;
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT new.rowid, new.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = new."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."content_id" AND dv.variant = 'transcript'), '')) END)
   WHERE new.deleted_at IS NULL;
END;

-- trigger fts_core_document_ad
CREATE TRIGGER fts_core_document_ad AFTER DELETE ON core_document BEGIN
  DELETE FROM fts_core_document WHERE rowid = old.rowid;
END;

-- trigger fts_core_document_ai
CREATE TRIGGER fts_core_document_ai AFTER INSERT ON core_document BEGIN
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")) END)
   WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_core_document_au
CREATE TRIGGER fts_core_document_au AFTER UPDATE ON core_document BEGIN
  DELETE FROM fts_core_document WHERE rowid = old.rowid;
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT new.rowid, new."document_id", new."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = new."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = new."current_content_id")) END)
   WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_core_event_ad
CREATE TRIGGER fts_core_event_ad AFTER DELETE ON core_event BEGIN
  DELETE FROM fts_core_event WHERE rowid = old.rowid;
END;

-- trigger fts_core_event_ai
CREATE TRIGGER fts_core_event_ai AFTER INSERT ON core_event BEGIN
  INSERT INTO fts_core_event(rowid, event_id, summary, description) SELECT new.rowid, new."event_id", new."summary", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_core_event_au
CREATE TRIGGER fts_core_event_au AFTER UPDATE ON core_event BEGIN
  DELETE FROM fts_core_event WHERE rowid = old.rowid;
  INSERT INTO fts_core_event(rowid, event_id, summary, description) SELECT new.rowid, new."event_id", new."summary", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_core_party_ad
CREATE TRIGGER fts_core_party_ad AFTER DELETE ON core_party BEGIN
  DELETE FROM fts_core_party WHERE rowid = old.rowid;
END;

-- trigger fts_core_party_ai
CREATE TRIGGER fts_core_party_ai AFTER INSERT ON core_party BEGIN
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name) SELECT new.rowid, new."party_id", new."display_name", new."sort_name";
END;

-- trigger fts_core_party_au
CREATE TRIGGER fts_core_party_au AFTER UPDATE ON core_party BEGIN
  DELETE FROM fts_core_party WHERE rowid = old.rowid;
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name) SELECT new.rowid, new."party_id", new."display_name", new."sort_name";
END;

-- trigger fts_core_place_ad
CREATE TRIGGER fts_core_place_ad AFTER DELETE ON core_place BEGIN
  DELETE FROM fts_core_place WHERE rowid = old.rowid;
END;

-- trigger fts_core_place_ai
CREATE TRIGGER fts_core_place_ai AFTER INSERT ON core_place BEGIN
  INSERT INTO fts_core_place(rowid, place_id, name) SELECT new.rowid, new."place_id", new."name";
END;

-- trigger fts_core_place_au
CREATE TRIGGER fts_core_place_au AFTER UPDATE ON core_place BEGIN
  DELETE FROM fts_core_place WHERE rowid = old.rowid;
  INSERT INTO fts_core_place(rowid, place_id, name) SELECT new.rowid, new."place_id", new."name";
END;

-- trigger fts_core_transaction_ad
CREATE TRIGGER fts_core_transaction_ad AFTER DELETE ON core_transaction BEGIN
  DELETE FROM fts_core_transaction WHERE rowid = old.rowid;
END;

-- trigger fts_core_transaction_ai
CREATE TRIGGER fts_core_transaction_ai AFTER INSERT ON core_transaction BEGIN
  INSERT INTO fts_core_transaction(rowid, txn_id, description) SELECT new.rowid, new."txn_id", new."description";
END;

-- trigger fts_core_transaction_au
CREATE TRIGGER fts_core_transaction_au AFTER UPDATE ON core_transaction BEGIN
  DELETE FROM fts_core_transaction WHERE rowid = old.rowid;
  INSERT INTO fts_core_transaction(rowid, txn_id, description) SELECT new.rowid, new."txn_id", new."description";
END;

-- trigger fts_knowledge_annotation_ad
CREATE TRIGGER fts_knowledge_annotation_ad AFTER DELETE ON knowledge_annotation BEGIN
  DELETE FROM fts_knowledge_annotation WHERE rowid = old.rowid;
END;

-- trigger fts_knowledge_annotation_ai
CREATE TRIGGER fts_knowledge_annotation_ai AFTER INSERT ON knowledge_annotation BEGIN
  INSERT INTO fts_knowledge_annotation(rowid, annotation_id, body_text) SELECT new.rowid, new."annotation_id", new."body_text";
END;

-- trigger fts_knowledge_annotation_au
CREATE TRIGGER fts_knowledge_annotation_au AFTER UPDATE ON knowledge_annotation BEGIN
  DELETE FROM fts_knowledge_annotation WHERE rowid = old.rowid;
  INSERT INTO fts_knowledge_annotation(rowid, annotation_id, body_text) SELECT new.rowid, new."annotation_id", new."body_text";
END;

-- trigger fts_knowledge_note_ad
CREATE TRIGGER fts_knowledge_note_ad AFTER DELETE ON knowledge_note BEGIN
  DELETE FROM fts_knowledge_note WHERE rowid = old.rowid;
END;

-- trigger fts_knowledge_note_ai
CREATE TRIGGER fts_knowledge_note_ai AFTER INSERT ON knowledge_note BEGIN
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body) SELECT new.rowid, new."note_id", new."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") END) WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_knowledge_note_au
CREATE TRIGGER fts_knowledge_note_au AFTER UPDATE ON knowledge_note BEGIN
  DELETE FROM fts_knowledge_note WHERE rowid = old.rowid;
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body) SELECT new.rowid, new."note_id", new."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") END) WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_locker_item_ad
CREATE TRIGGER fts_locker_item_ad AFTER DELETE ON locker_item BEGIN
  DELETE FROM fts_locker_item WHERE rowid = old.rowid;
END;

-- trigger fts_locker_item_ai
CREATE TRIGGER fts_locker_item_ai AFTER INSERT ON locker_item BEGIN
  INSERT INTO fts_locker_item(rowid, item_id, title, username, url) SELECT new.rowid, new."item_id", new."title", new."username", new."url" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_locker_item_au
CREATE TRIGGER fts_locker_item_au AFTER UPDATE ON locker_item BEGIN
  DELETE FROM fts_locker_item WHERE rowid = old.rowid;
  INSERT INTO fts_locker_item(rowid, item_id, title, username, url) SELECT new.rowid, new."item_id", new."title", new."username", new."url" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_people_profile_ad
CREATE TRIGGER fts_people_profile_ad AFTER DELETE ON people_profile BEGIN
  DELETE FROM fts_people_profile WHERE rowid = old.rowid;
END;

-- trigger fts_people_profile_ai
CREATE TRIGGER fts_people_profile_ai AFTER INSERT ON people_profile BEGIN
  INSERT INTO fts_people_profile(rowid, profile_id, role, nickname) SELECT new.rowid, new."profile_id", new."role", new."nickname" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_people_profile_au
CREATE TRIGGER fts_people_profile_au AFTER UPDATE ON people_profile BEGIN
  DELETE FROM fts_people_profile WHERE rowid = old.rowid;
  INSERT INTO fts_people_profile(rowid, profile_id, role, nickname) SELECT new.rowid, new."profile_id", new."role", new."nickname" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_schedule_project_ad
CREATE TRIGGER fts_schedule_project_ad AFTER DELETE ON schedule_project BEGIN
  DELETE FROM fts_schedule_project WHERE rowid = old.rowid;
END;

-- trigger fts_schedule_project_ai
CREATE TRIGGER fts_schedule_project_ai AFTER INSERT ON schedule_project BEGIN
  INSERT INTO fts_schedule_project(rowid, project_id, name) SELECT new.rowid, new."project_id", new."name";
END;

-- trigger fts_schedule_project_au
CREATE TRIGGER fts_schedule_project_au AFTER UPDATE ON schedule_project BEGIN
  DELETE FROM fts_schedule_project WHERE rowid = old.rowid;
  INSERT INTO fts_schedule_project(rowid, project_id, name) SELECT new.rowid, new."project_id", new."name";
END;

-- trigger fts_schedule_task_ad
CREATE TRIGGER fts_schedule_task_ad AFTER DELETE ON schedule_task BEGIN
  DELETE FROM fts_schedule_task WHERE rowid = old.rowid;
END;

-- trigger fts_schedule_task_ai
CREATE TRIGGER fts_schedule_task_ai AFTER INSERT ON schedule_task BEGIN
  INSERT INTO fts_schedule_task(rowid, task_id, title, description) SELECT new.rowid, new."task_id", new."title", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_schedule_task_au
CREATE TRIGGER fts_schedule_task_au AFTER UPDATE ON schedule_task BEGIN
  DELETE FROM fts_schedule_task WHERE rowid = old.rowid;
  INSERT INTO fts_schedule_task(rowid, task_id, title, description) SELECT new.rowid, new."task_id", new."title", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_social_circle_ad
CREATE TRIGGER fts_social_circle_ad AFTER DELETE ON social_circle BEGIN
  DELETE FROM fts_social_circle WHERE rowid = old.rowid;
END;

-- trigger fts_social_circle_ai
CREATE TRIGGER fts_social_circle_ai AFTER INSERT ON social_circle BEGIN
  INSERT INTO fts_social_circle(rowid, circle_id, name) SELECT new.rowid, new."circle_id", new."name";
END;

-- trigger fts_social_circle_au
CREATE TRIGGER fts_social_circle_au AFTER UPDATE ON social_circle BEGIN
  DELETE FROM fts_social_circle WHERE rowid = old.rowid;
  INSERT INTO fts_social_circle(rowid, circle_id, name) SELECT new.rowid, new."circle_id", new."name";
END;

-- trigger fts_social_message_ad
CREATE TRIGGER fts_social_message_ad AFTER DELETE ON social_message BEGIN
  DELETE FROM fts_social_message WHERE rowid = old.rowid;
END;

-- trigger fts_social_message_ai
CREATE TRIGGER fts_social_message_ai AFTER INSERT ON social_message BEGIN
  INSERT INTO fts_social_message(rowid, message_id, body) SELECT new.rowid, new."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") END);
END;

-- trigger fts_social_message_au
CREATE TRIGGER fts_social_message_au AFTER UPDATE ON social_message BEGIN
  DELETE FROM fts_social_message WHERE rowid = old.rowid;
  INSERT INTO fts_social_message(rowid, message_id, body) SELECT new.rowid, new."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = new."body_content_id") END);
END;

-- trigger fts_social_thread_ad
CREATE TRIGGER fts_social_thread_ad AFTER DELETE ON social_thread BEGIN
  DELETE FROM fts_social_thread WHERE rowid = old.rowid;
END;

-- trigger fts_social_thread_ai
CREATE TRIGGER fts_social_thread_ai AFTER INSERT ON social_thread BEGIN
  INSERT INTO fts_social_thread(rowid, thread_id, subject) SELECT new.rowid, new."thread_id", new."subject";
END;

-- trigger fts_social_thread_au
CREATE TRIGGER fts_social_thread_au AFTER UPDATE ON social_thread BEGIN
  DELETE FROM fts_social_thread WHERE rowid = old.rowid;
  INSERT INTO fts_social_thread(rowid, thread_id, subject) SELECT new.rowid, new."thread_id", new."subject";
END;

-- trigger fts_tally_expense_ad
CREATE TRIGGER fts_tally_expense_ad AFTER DELETE ON tally_expense BEGIN
  DELETE FROM fts_tally_expense WHERE rowid = old.rowid;
END;

-- trigger fts_tally_expense_ai
CREATE TRIGGER fts_tally_expense_ai AFTER INSERT ON tally_expense BEGIN
  INSERT INTO fts_tally_expense(rowid, expense_id, description) SELECT new.rowid, new."expense_id", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger fts_tally_expense_au
CREATE TRIGGER fts_tally_expense_au AFTER UPDATE ON tally_expense BEGIN
  DELETE FROM fts_tally_expense WHERE rowid = old.rowid;
  INSERT INTO fts_tally_expense(rowid, expense_id, description) SELECT new.rowid, new."expense_id", new."description" WHERE new."deleted_at" IS NULL;
END;

-- trigger knowledge_annotation_entity_delete
CREATE TRIGGER knowledge_annotation_entity_delete
AFTER DELETE ON knowledge_annotation
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.annotation_id;
END;

-- trigger knowledge_annotation_entity_insert
CREATE TRIGGER knowledge_annotation_entity_insert
BEFORE INSERT ON knowledge_annotation
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: knowledge_annotation (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.annotation_id AND entity_type <> 'knowledge.annotation');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.annotation_id, 'knowledge.annotation', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger knowledge_annotation_touch_updated_at
CREATE TRIGGER knowledge_annotation_touch_updated_at
AFTER UPDATE ON knowledge_annotation
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE knowledge_annotation
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE annotation_id = NEW.annotation_id;
END;

-- trigger knowledge_note_entity_delete
CREATE TRIGGER knowledge_note_entity_delete
AFTER DELETE ON knowledge_note
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.note_id;
END;

-- trigger knowledge_note_entity_insert
CREATE TRIGGER knowledge_note_entity_insert
BEFORE INSERT ON knowledge_note
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: knowledge_note (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.note_id AND entity_type <> 'knowledge.note');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.note_id, 'knowledge.note', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger knowledge_note_touch_updated_at
CREATE TRIGGER knowledge_note_touch_updated_at
AFTER UPDATE ON knowledge_note
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE knowledge_note
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE note_id = NEW.note_id;
END;

-- trigger locker_item_address_entity_delete
CREATE TRIGGER locker_item_address_entity_delete
AFTER DELETE ON locker_item_address
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.address_id;
END;

-- trigger locker_item_address_entity_insert
CREATE TRIGGER locker_item_address_entity_insert
BEFORE INSERT ON locker_item_address
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: locker_item_address (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.address_id AND entity_type <> 'locker.item_address');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.address_id, 'locker.item_address', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger locker_item_entity_delete
CREATE TRIGGER locker_item_entity_delete
AFTER DELETE ON locker_item
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.item_id;
END;

-- trigger locker_item_entity_insert
CREATE TRIGGER locker_item_entity_insert
BEFORE INSERT ON locker_item
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: locker_item (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.item_id AND entity_type <> 'locker.item');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.item_id, 'locker.item', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger locker_item_field_entity_delete
CREATE TRIGGER locker_item_field_entity_delete
AFTER DELETE ON locker_item_field
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.field_id;
END;

-- trigger locker_item_field_entity_insert
CREATE TRIGGER locker_item_field_entity_insert
BEFORE INSERT ON locker_item_field
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: locker_item_field (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.field_id AND entity_type <> 'locker.item_field');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.field_id, 'locker.item_field', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger locker_item_field_touch_updated_at
CREATE TRIGGER locker_item_field_touch_updated_at
AFTER UPDATE ON locker_item_field
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item_field
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE field_id = NEW.field_id;
END;

-- trigger locker_item_passkey_touch_updated_at
CREATE TRIGGER locker_item_passkey_touch_updated_at
AFTER UPDATE ON locker_item_passkey
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item_passkey
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE item_id = NEW.item_id;
END;

-- trigger locker_item_touch_updated_at
CREATE TRIGGER locker_item_touch_updated_at
AFTER UPDATE ON locker_item
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE item_id = NEW.item_id;
END;

-- trigger media_asset_entity_delete
CREATE TRIGGER media_asset_entity_delete
AFTER DELETE ON media_asset
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.asset_id;
END;

-- trigger media_asset_entity_insert
CREATE TRIGGER media_asset_entity_insert
BEFORE INSERT ON media_asset
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: media_asset (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.asset_id AND entity_type <> 'media.asset');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.asset_id, 'media.asset', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger media_asset_phash_touch_updated_at
CREATE TRIGGER media_asset_phash_touch_updated_at
AFTER UPDATE ON media_asset_phash
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE media_asset_phash
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE asset_id = NEW.asset_id;
END;

-- trigger media_asset_touch_updated_at
CREATE TRIGGER media_asset_touch_updated_at
AFTER UPDATE ON media_asset
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE media_asset
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE asset_id = NEW.asset_id;
END;

-- trigger media_face_cluster_touch_updated_at
CREATE TRIGGER media_face_cluster_touch_updated_at
AFTER UPDATE ON media_face_cluster
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE media_face_cluster
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE region_id = NEW.region_id;
END;

-- trigger media_face_region_entity_delete
CREATE TRIGGER media_face_region_entity_delete
AFTER DELETE ON media_face_region
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.region_id;
END;

-- trigger media_face_region_entity_insert
CREATE TRIGGER media_face_region_entity_insert
BEFORE INSERT ON media_face_region
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: media_face_region (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.region_id AND entity_type <> 'media.face_region');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.region_id, 'media.face_region', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger media_face_region_touch_updated_at
CREATE TRIGGER media_face_region_touch_updated_at
AFTER UPDATE ON media_face_region
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE media_face_region
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE region_id = NEW.region_id;
END;

-- trigger media_memory_entity_delete
CREATE TRIGGER media_memory_entity_delete
AFTER DELETE ON media_memory
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.memory_id;
END;

-- trigger media_memory_entity_insert
CREATE TRIGGER media_memory_entity_insert
BEFORE INSERT ON media_memory
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: media_memory (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.memory_id AND entity_type <> 'media.memory');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.memory_id, 'media.memory', COALESCE(NEW.computed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger people_important_date_entity_delete
CREATE TRIGGER people_important_date_entity_delete
AFTER DELETE ON people_important_date
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.date_id;
END;

-- trigger people_important_date_entity_insert
CREATE TRIGGER people_important_date_entity_insert
BEFORE INSERT ON people_important_date
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: people_important_date (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.date_id AND entity_type <> 'people.important_date');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.date_id, 'people.important_date', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger people_important_date_touch_updated_at
CREATE TRIGGER people_important_date_touch_updated_at
AFTER UPDATE ON people_important_date
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE people_important_date
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE date_id = NEW.date_id;
END;

-- trigger people_profile_entity_delete
CREATE TRIGGER people_profile_entity_delete
AFTER DELETE ON people_profile
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.profile_id;
END;

-- trigger people_profile_entity_insert
CREATE TRIGGER people_profile_entity_insert
BEFORE INSERT ON people_profile
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: people_profile (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.profile_id AND entity_type <> 'people.profile');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.profile_id, 'people.profile', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger people_profile_touch_updated_at
CREATE TRIGGER people_profile_touch_updated_at
AFTER UPDATE ON people_profile
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE people_profile
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE profile_id = NEW.profile_id;
END;

-- trigger replica_intent_outcome_touch_updated_at
CREATE TRIGGER replica_intent_outcome_touch_updated_at
AFTER UPDATE ON replica_intent_outcome
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE replica_intent_outcome
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE intent_id = NEW.intent_id;
END;

-- trigger schedule_attendee_entity_delete
CREATE TRIGGER schedule_attendee_entity_delete
AFTER DELETE ON schedule_attendee
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.attendee_id;
END;

-- trigger schedule_attendee_entity_insert
CREATE TRIGGER schedule_attendee_entity_insert
BEFORE INSERT ON schedule_attendee
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_attendee (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.attendee_id AND entity_type <> 'schedule.attendee');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.attendee_id, 'schedule.attendee', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_attendee_touch_updated_at
CREATE TRIGGER schedule_attendee_touch_updated_at
AFTER UPDATE ON schedule_attendee
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_attendee
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE attendee_id = NEW.attendee_id;
END;

-- trigger schedule_calendar_entity_delete
CREATE TRIGGER schedule_calendar_entity_delete
AFTER DELETE ON schedule_calendar
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.calendar_id;
END;

-- trigger schedule_calendar_entity_insert
CREATE TRIGGER schedule_calendar_entity_insert
BEFORE INSERT ON schedule_calendar
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_calendar (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.calendar_id AND entity_type <> 'schedule.calendar');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.calendar_id, 'schedule.calendar', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_chair_matches_organizer_insert
CREATE TRIGGER schedule_chair_matches_organizer_insert
BEFORE INSERT ON schedule_attendee
WHEN NEW.role = 'chair' AND NOT EXISTS (
  SELECT 1 FROM core_event e
   WHERE e.event_id = NEW.event_id
     AND e.organizer_party_id = NEW.party_id
)
BEGIN
  SELECT RAISE(ABORT, 'chair attendee must match the event organizer');
END;

-- trigger schedule_chair_matches_organizer_update
CREATE TRIGGER schedule_chair_matches_organizer_update
BEFORE UPDATE OF event_id, party_id, role ON schedule_attendee
WHEN NEW.role = 'chair' AND NOT EXISTS (
  SELECT 1 FROM core_event e
   WHERE e.event_id = NEW.event_id
     AND e.organizer_party_id = NEW.party_id
)
BEGIN
  SELECT RAISE(ABORT, 'chair attendee must match the event organizer');
END;

-- trigger schedule_event_ext_entity_delete
CREATE TRIGGER schedule_event_ext_entity_delete
AFTER DELETE ON schedule_event_ext
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.event_ext_id;
END;

-- trigger schedule_event_ext_entity_insert
CREATE TRIGGER schedule_event_ext_entity_insert
BEFORE INSERT ON schedule_event_ext
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_event_ext (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.event_ext_id AND entity_type <> 'schedule.event_ext');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.event_ext_id, 'schedule.event_ext', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_event_ext_touch_updated_at
CREATE TRIGGER schedule_event_ext_touch_updated_at
AFTER UPDATE ON schedule_event_ext
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_event_ext
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE event_ext_id = NEW.event_ext_id;
END;

-- trigger schedule_organizer_matches_chair_update
CREATE TRIGGER schedule_organizer_matches_chair_update
BEFORE UPDATE OF organizer_party_id ON core_event
WHEN EXISTS (
  SELECT 1 FROM schedule_attendee a
   WHERE a.event_id = OLD.event_id
     AND a.role = 'chair'
     AND a.party_id IS NOT NEW.organizer_party_id
)
BEGIN
  SELECT RAISE(ABORT, 'event organizer must match its chair attendee');
END;

-- trigger schedule_project_entity_delete
CREATE TRIGGER schedule_project_entity_delete
AFTER DELETE ON schedule_project
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.project_id;
END;

-- trigger schedule_project_entity_insert
CREATE TRIGGER schedule_project_entity_insert
BEFORE INSERT ON schedule_project
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_project (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.project_id AND entity_type <> 'schedule.project');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.project_id, 'schedule.project', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_project_touch_updated_at
CREATE TRIGGER schedule_project_touch_updated_at
AFTER UPDATE ON schedule_project
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_project
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE project_id = NEW.project_id;
END;

-- trigger schedule_recurrence_exception_attendee_touch_updated_at
CREATE TRIGGER schedule_recurrence_exception_attendee_touch_updated_at
AFTER UPDATE ON schedule_recurrence_exception_attendee
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_recurrence_exception_attendee
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE exception_id = NEW.exception_id AND party_id = NEW.party_id;
END;

-- trigger schedule_recurrence_exception_entity_delete
CREATE TRIGGER schedule_recurrence_exception_entity_delete
AFTER DELETE ON schedule_recurrence_exception
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.exception_id;
END;

-- trigger schedule_recurrence_exception_entity_insert
CREATE TRIGGER schedule_recurrence_exception_entity_insert
BEFORE INSERT ON schedule_recurrence_exception
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_recurrence_exception (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.exception_id AND entity_type <> 'schedule.recurrence_exception');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.exception_id, 'schedule.recurrence_exception', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_recurrence_exception_touch_updated_at
CREATE TRIGGER schedule_recurrence_exception_touch_updated_at
AFTER UPDATE ON schedule_recurrence_exception
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_recurrence_exception
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE exception_id = NEW.exception_id;
END;

-- trigger schedule_section_entity_delete
CREATE TRIGGER schedule_section_entity_delete
AFTER DELETE ON schedule_section
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.section_id;
END;

-- trigger schedule_section_entity_insert
CREATE TRIGGER schedule_section_entity_insert
BEFORE INSERT ON schedule_section
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_section (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.section_id AND entity_type <> 'schedule.section');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.section_id, 'schedule.section', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_section_touch_updated_at
CREATE TRIGGER schedule_section_touch_updated_at
AFTER UPDATE ON schedule_section
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_section
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE section_id = NEW.section_id;
END;

-- trigger schedule_task_entity_delete
CREATE TRIGGER schedule_task_entity_delete
AFTER DELETE ON schedule_task
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.task_id;
END;

-- trigger schedule_task_entity_insert
CREATE TRIGGER schedule_task_entity_insert
BEFORE INSERT ON schedule_task
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: schedule_task (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.task_id AND entity_type <> 'schedule.task');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.task_id, 'schedule.task', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger schedule_task_hierarchy_is_acyclic
CREATE TRIGGER schedule_task_hierarchy_is_acyclic
BEFORE UPDATE OF parent_task_id ON schedule_task
WHEN NEW.parent_task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'schedule.task: that parent is already below this task — a task hierarchy has no loops (issue #996, ruling R21)')
   WHERE EXISTS (
     WITH RECURSIVE ancestors(task_id) AS (
       SELECT NEW.parent_task_id
       UNION
       SELECT parent.parent_task_id
         FROM schedule_task parent
         JOIN ancestors ON parent.task_id = ancestors.task_id
        WHERE parent.parent_task_id IS NOT NULL
     )
     SELECT 1 FROM ancestors WHERE task_id = NEW.task_id
   );
END;

-- trigger schedule_task_section_agrees_with_project_ai
CREATE TRIGGER schedule_task_section_agrees_with_project_ai
BEFORE INSERT ON schedule_task
WHEN NEW.section_id IS NOT NULL
 AND (SELECT project_id FROM schedule_section WHERE section_id = NEW.section_id)
     IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'schedule.task: that section belongs to a different project (issue #996, ruling R21)');
END;

-- trigger schedule_task_section_agrees_with_project_au
CREATE TRIGGER schedule_task_section_agrees_with_project_au
BEFORE UPDATE ON schedule_task
WHEN NEW.section_id IS NOT NULL
 AND (SELECT project_id FROM schedule_section WHERE section_id = NEW.section_id)
     IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'schedule.task: that section belongs to a different project (issue #996, ruling R21)');
END;

-- trigger schedule_task_touch_updated_at
CREATE TRIGGER schedule_task_touch_updated_at
AFTER UPDATE ON schedule_task
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE schedule_task
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE task_id = NEW.task_id;
END;

-- trigger share_fulfillment_touch_updated_at
CREATE TRIGGER share_fulfillment_touch_updated_at
AFTER UPDATE ON share_fulfillment
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE share_fulfillment
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE grant_id = NEW.grant_id AND peer_vault_id = NEW.peer_vault_id;
END;

-- trigger share_party_vault_binding_not_self_ai
CREATE TRIGGER share_party_vault_binding_not_self_ai
BEFORE INSERT ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;

-- trigger share_party_vault_binding_not_self_au
CREATE TRIGGER share_party_vault_binding_not_self_au
BEFORE UPDATE OF party_id, vault_id ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;

-- trigger share_subscription_touch_updated_at
CREATE TRIGGER share_subscription_touch_updated_at
AFTER UPDATE ON share_subscription
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE share_subscription
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE authority_id = NEW.authority_id AND audience_vault_id = NEW.audience_vault_id;
END;

-- trigger social_circle_entity_delete
CREATE TRIGGER social_circle_entity_delete
AFTER DELETE ON social_circle
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.circle_id;
END;

-- trigger social_circle_entity_insert
CREATE TRIGGER social_circle_entity_insert
BEFORE INSERT ON social_circle
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_circle (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.circle_id AND entity_type <> 'social.circle');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.circle_id, 'social.circle', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_circle_member_entity_delete
CREATE TRIGGER social_circle_member_entity_delete
AFTER DELETE ON social_circle_member
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.member_id;
END;

-- trigger social_circle_member_entity_insert
CREATE TRIGGER social_circle_member_entity_insert
BEFORE INSERT ON social_circle_member
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_circle_member (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.member_id AND entity_type <> 'social.circle_member');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.member_id, 'social.circle_member', COALESCE(NEW.added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_circle_member_touch_updated_at
CREATE TRIGGER social_circle_member_touch_updated_at
AFTER UPDATE ON social_circle_member
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_circle_member
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE member_id = NEW.member_id;
END;

-- trigger social_circle_touch_updated_at
CREATE TRIGGER social_circle_touch_updated_at
AFTER UPDATE ON social_circle
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_circle
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE circle_id = NEW.circle_id;
END;

-- trigger social_contact_channel_entity_delete
CREATE TRIGGER social_contact_channel_entity_delete
AFTER DELETE ON social_contact_channel
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.channel_id;
END;

-- trigger social_contact_channel_entity_insert
CREATE TRIGGER social_contact_channel_entity_insert
BEFORE INSERT ON social_contact_channel
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_contact_channel (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.channel_id AND entity_type <> 'social.contact_channel');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.channel_id, 'social.contact_channel', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_contact_channel_touch_updated_at
CREATE TRIGGER social_contact_channel_touch_updated_at
AFTER UPDATE ON social_contact_channel
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_contact_channel
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE channel_id = NEW.channel_id;
END;

-- trigger social_message_entity_delete
CREATE TRIGGER social_message_entity_delete
AFTER DELETE ON social_message
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.message_id;
END;

-- trigger social_message_entity_insert
CREATE TRIGGER social_message_entity_insert
BEFORE INSERT ON social_message
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_message (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.message_id AND entity_type <> 'social.message');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.message_id, 'social.message', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_message_touch_updated_at
CREATE TRIGGER social_message_touch_updated_at
AFTER UPDATE ON social_message
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_message
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE message_id = NEW.message_id;
END;

-- trigger social_thread_entity_delete
CREATE TRIGGER social_thread_entity_delete
AFTER DELETE ON social_thread
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.thread_id;
END;

-- trigger social_thread_entity_insert
CREATE TRIGGER social_thread_entity_insert
BEFORE INSERT ON social_thread
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_thread (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.thread_id AND entity_type <> 'social.thread');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.thread_id, 'social.thread', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_thread_participant_entity_delete
CREATE TRIGGER social_thread_participant_entity_delete
AFTER DELETE ON social_thread_participant
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.tp_id;
END;

-- trigger social_thread_participant_entity_insert
CREATE TRIGGER social_thread_participant_entity_insert
BEFORE INSERT ON social_thread_participant
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: social_thread_participant (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.tp_id AND entity_type <> 'social.thread_participant');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.tp_id, 'social.thread_participant', COALESCE(NEW.joined_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger social_thread_participant_touch_updated_at
CREATE TRIGGER social_thread_participant_touch_updated_at
AFTER UPDATE ON social_thread_participant
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_thread_participant
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE tp_id = NEW.tp_id;
END;

-- trigger social_thread_touch_updated_at
CREATE TRIGGER social_thread_touch_updated_at
AFTER UPDATE ON social_thread
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE social_thread
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE thread_id = NEW.thread_id;
END;

-- trigger sync_connection_credential_touch_updated_at
CREATE TRIGGER sync_connection_credential_touch_updated_at
AFTER UPDATE ON sync_connection_credential
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE sync_connection_credential
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE connection_id = NEW.connection_id;
END;

-- trigger sync_connection_cursor_touch_updated_at
CREATE TRIGGER sync_connection_cursor_touch_updated_at
AFTER UPDATE ON sync_connection_cursor
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE sync_connection_cursor
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE cursor_id = NEW.cursor_id;
END;

-- trigger sync_connection_health_touch_updated_at
CREATE TRIGGER sync_connection_health_touch_updated_at
AFTER UPDATE ON sync_connection_health
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE sync_connection_health
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE connection_id = NEW.connection_id;
END;

-- trigger tally_expense_currency_matches_group_ai
CREATE TRIGGER tally_expense_currency_matches_group_ai
BEFORE INSERT ON tally_expense
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.expense: an expense in a group is in that group''s currency');
END;

-- trigger tally_expense_currency_matches_group_au
CREATE TRIGGER tally_expense_currency_matches_group_au
BEFORE UPDATE OF currency, group_id ON tally_expense
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.expense: an expense in a group is in that group''s currency');
END;

-- trigger tally_expense_entity_delete
CREATE TRIGGER tally_expense_entity_delete
AFTER DELETE ON tally_expense
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.expense_id;
END;

-- trigger tally_expense_entity_insert
CREATE TRIGGER tally_expense_entity_insert
BEFORE INSERT ON tally_expense
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_expense (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.expense_id AND entity_type <> 'tally.expense');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.expense_id, 'tally.expense', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_expense_line_allocation_touch_updated_at
CREATE TRIGGER tally_expense_line_allocation_touch_updated_at
AFTER UPDATE ON tally_expense_line_allocation
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_expense_line_allocation
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE line_item_id = NEW.line_item_id AND party_id = NEW.party_id;
END;

-- trigger tally_expense_line_item_entity_delete
CREATE TRIGGER tally_expense_line_item_entity_delete
AFTER DELETE ON tally_expense_line_item
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.line_item_id;
END;

-- trigger tally_expense_line_item_entity_insert
CREATE TRIGGER tally_expense_line_item_entity_insert
BEFORE INSERT ON tally_expense_line_item
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_expense_line_item (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.line_item_id AND entity_type <> 'tally.expense_line_item');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.line_item_id, 'tally.expense_line_item', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_expense_line_item_touch_updated_at
CREATE TRIGGER tally_expense_line_item_touch_updated_at
AFTER UPDATE ON tally_expense_line_item
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_expense_line_item
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE line_item_id = NEW.line_item_id;
END;

-- trigger tally_expense_payer_touch_updated_at
CREATE TRIGGER tally_expense_payer_touch_updated_at
AFTER UPDATE ON tally_expense_payer
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_expense_payer
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE expense_id = NEW.expense_id AND party_id = NEW.party_id;
END;

-- trigger tally_expense_split_touch_updated_at
CREATE TRIGGER tally_expense_split_touch_updated_at
AFTER UPDATE ON tally_expense_split
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_expense_split
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE expense_id = NEW.expense_id AND party_id = NEW.party_id;
END;

-- trigger tally_expense_touch_updated_at
CREATE TRIGGER tally_expense_touch_updated_at
AFTER UPDATE ON tally_expense
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_expense
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE expense_id = NEW.expense_id;
END;

-- trigger tally_friend_entity_delete
CREATE TRIGGER tally_friend_entity_delete
AFTER DELETE ON tally_friend
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.friend_id;
END;

-- trigger tally_friend_entity_insert
CREATE TRIGGER tally_friend_entity_insert
BEFORE INSERT ON tally_friend
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_friend (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.friend_id AND entity_type <> 'tally.friend');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.friend_id, 'tally.friend', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_friend_touch_updated_at
CREATE TRIGGER tally_friend_touch_updated_at
AFTER UPDATE ON tally_friend
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_friend
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE friend_id = NEW.friend_id;
END;

-- trigger tally_group_entity_delete
CREATE TRIGGER tally_group_entity_delete
AFTER DELETE ON tally_group
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.group_id;
END;

-- trigger tally_group_entity_insert
CREATE TRIGGER tally_group_entity_insert
BEFORE INSERT ON tally_group
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_group (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.group_id AND entity_type <> 'tally.group');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.group_id, 'tally.group', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_group_touch_updated_at
CREATE TRIGGER tally_group_touch_updated_at
AFTER UPDATE ON tally_group
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_group
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE group_id = NEW.group_id;
END;

-- trigger tally_nudge_entity_delete
CREATE TRIGGER tally_nudge_entity_delete
AFTER DELETE ON tally_nudge
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.nudge_id;
END;

-- trigger tally_nudge_entity_insert
CREATE TRIGGER tally_nudge_entity_insert
BEFORE INSERT ON tally_nudge
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_nudge (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.nudge_id AND entity_type <> 'tally.nudge');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.nudge_id, 'tally.nudge', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_nudge_touch_updated_at
CREATE TRIGGER tally_nudge_touch_updated_at
AFTER UPDATE ON tally_nudge
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_nudge
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE nudge_id = NEW.nudge_id;
END;

-- trigger tally_obligation_entity_delete
CREATE TRIGGER tally_obligation_entity_delete
AFTER DELETE ON tally_obligation
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.obligation_id;
END;

-- trigger tally_obligation_entity_insert
CREATE TRIGGER tally_obligation_entity_insert
BEFORE INSERT ON tally_obligation
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_obligation (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.obligation_id AND entity_type <> 'tally.obligation');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.obligation_id, 'tally.obligation', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_obligation_touch_updated_at
CREATE TRIGGER tally_obligation_touch_updated_at
AFTER UPDATE ON tally_obligation
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_obligation
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE obligation_id = NEW.obligation_id;
END;

-- trigger tally_recurring_expense_entity_delete
CREATE TRIGGER tally_recurring_expense_entity_delete
AFTER DELETE ON tally_recurring_expense
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.template_id;
END;

-- trigger tally_recurring_expense_entity_insert
CREATE TRIGGER tally_recurring_expense_entity_insert
BEFORE INSERT ON tally_recurring_expense
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_recurring_expense (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.template_id AND entity_type <> 'tally.recurring_expense');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.template_id, 'tally.recurring_expense', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_recurring_expense_split_touch_updated_at
CREATE TRIGGER tally_recurring_expense_split_touch_updated_at
AFTER UPDATE ON tally_recurring_expense_split
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_recurring_expense_split
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE template_id = NEW.template_id AND party_id = NEW.party_id;
END;

-- trigger tally_recurring_expense_touch_updated_at
CREATE TRIGGER tally_recurring_expense_touch_updated_at
AFTER UPDATE ON tally_recurring_expense
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_recurring_expense
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE template_id = NEW.template_id;
END;

-- trigger tally_settlement_currency_matches_group_ai
CREATE TRIGGER tally_settlement_currency_matches_group_ai
BEFORE INSERT ON tally_settlement
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.settlement: a settlement in a group is in that group''s currency');
END;

-- trigger tally_settlement_currency_matches_group_au
CREATE TRIGGER tally_settlement_currency_matches_group_au
BEFORE UPDATE OF currency, group_id ON tally_settlement
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.settlement: a settlement in a group is in that group''s currency');
END;

-- trigger tally_settlement_entity_delete
CREATE TRIGGER tally_settlement_entity_delete
AFTER DELETE ON tally_settlement
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.settlement_id;
END;

-- trigger tally_settlement_entity_insert
CREATE TRIGGER tally_settlement_entity_insert
BEFORE INSERT ON tally_settlement
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: tally_settlement (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.settlement_id AND entity_type <> 'tally.settlement');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.settlement_id, 'tally.settlement', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger tally_settlement_touch_updated_at
CREATE TRIGGER tally_settlement_touch_updated_at
AFTER UPDATE ON tally_settlement
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE tally_settlement
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE settlement_id = NEW.settlement_id;
END;

-- trigger trg_fts_content_item_asset_ad
CREATE TRIGGER trg_fts_content_item_asset_ad AFTER DELETE ON media_asset
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = OLD.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = OLD.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_item_asset_ai
CREATE TRIGGER trg_fts_content_item_asset_ai AFTER INSERT ON media_asset
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = NEW.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = NEW.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_item_asset_au
CREATE TRIGGER trg_fts_content_item_asset_au AFTER UPDATE OF title, content_id ON media_asset
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = OLD.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = OLD.content_id AND i.deleted_at IS NULL;
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = NEW.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = NEW.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_item_derivative_ad
CREATE TRIGGER trg_fts_content_item_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = OLD.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = OLD.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_item_derivative_ai
CREATE TRIGGER trg_fts_content_item_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = NEW.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = NEW.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_item_derivative_au
CREATE TRIGGER trg_fts_content_item_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_content_item
   WHERE rowid IN (SELECT rowid FROM core_content_item WHERE content_id = NEW.content_id);
  INSERT INTO fts_core_content_item (rowid, content_id, title)
  SELECT i.rowid, i.content_id, (CASE WHEN trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) IS NULL THEN NULL
                 WHEN length(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), ''))) > 262144
                 THEN substr(trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')), 1, 262144) || ' ...(truncated for search index)'
                 ELSE trim(COALESCE((SELECT a."title" FROM media_asset a WHERE a.content_id = i."content_id"), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'text'), '') || ' ' || COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = i."content_id" AND dv.variant = 'transcript'), '')) END)
    FROM core_content_item i
   WHERE i.content_id = NEW.content_id AND i.deleted_at IS NULL;
END;

-- trigger trg_fts_content_text_ai
CREATE TRIGGER trg_fts_content_text_ai AFTER INSERT ON core_content_text
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."body_content_id" = NEW.content_id AND b."deleted_at" IS NULL;
  DELETE FROM fts_social_message
   WHERE rowid IN (SELECT rowid FROM social_message WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_social_message(rowid, message_id, body)
  SELECT b.rowid, b."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM social_message b
   WHERE b."body_content_id" = NEW.content_id;
END;

-- trigger trg_fts_content_text_au
CREATE TRIGGER trg_fts_content_text_au AFTER UPDATE ON core_content_text
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."body_content_id" = NEW.content_id AND b."deleted_at" IS NULL;
  DELETE FROM fts_social_message
   WHERE rowid IN (SELECT rowid FROM social_message WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_social_message(rowid, message_id, body)
  SELECT b.rowid, b."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM social_message b
   WHERE b."body_content_id" = NEW.content_id;
END;

-- trigger trg_fts_document_derivative_ad
CREATE TRIGGER trg_fts_document_derivative_ad AFTER DELETE ON core_content_derivative
WHEN OLD.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = OLD.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = OLD.content_id AND d."deleted_at" IS NULL;
END;

-- trigger trg_fts_document_derivative_ai
CREATE TRIGGER trg_fts_document_derivative_ai AFTER INSERT ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
END;

-- trigger trg_fts_document_derivative_au
CREATE TRIGGER trg_fts_document_derivative_au AFTER UPDATE ON core_content_derivative
WHEN NEW.variant IN ('text','transcript')
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
END;

-- trigger trg_fts_representation_ai
CREATE TRIGGER trg_fts_representation_ai AFTER INSERT ON core_content_representation
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE document_id = NEW.owner_id)
     AND NEW.owner_type = 'core.document';
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d."document_id" = NEW.owner_id AND NEW.owner_type = 'core.document' AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "note_id" = NEW.owner_id)
     AND NEW.owner_type = 'knowledge.note';
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."note_id" = NEW.owner_id AND NEW.owner_type = 'knowledge.note' AND b."deleted_at" IS NULL;
  DELETE FROM fts_social_message
   WHERE rowid IN (SELECT rowid FROM social_message WHERE "message_id" = NEW.owner_id)
     AND NEW.owner_type = 'social.message';
  INSERT INTO fts_social_message(rowid, message_id, body)
  SELECT b.rowid, b."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM social_message b
   WHERE b."message_id" = NEW.owner_id AND NEW.owner_type = 'social.message';
END;

-- trigger trg_fts_representation_au
CREATE TRIGGER trg_fts_representation_au AFTER UPDATE ON core_content_representation
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE document_id = NEW.owner_id)
     AND NEW.owner_type = 'core.document';
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d."document_id" = NEW.owner_id AND NEW.owner_type = 'core.document' AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "note_id" = NEW.owner_id)
     AND NEW.owner_type = 'knowledge.note';
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."note_id" = NEW.owner_id AND NEW.owner_type = 'knowledge.note' AND b."deleted_at" IS NULL;
  DELETE FROM fts_social_message
   WHERE rowid IN (SELECT rowid FROM social_message WHERE "message_id" = NEW.owner_id)
     AND NEW.owner_type = 'social.message';
  INSERT INTO fts_social_message(rowid, message_id, body)
  SELECT b.rowid, b."message_id", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM social_message b
   WHERE b."message_id" = NEW.owner_id AND NEW.owner_type = 'social.message';
END;
